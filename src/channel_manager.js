const ethers = require('ethers')
const path = require('path')
const fs = require('fs')
const {
  getChannelId,
  signState,
  getFixedPart,
  getVariablePart,
  createOutcome,
} = require('@statechannels/nitro-protocol')
const {
  AdjudicatorABI,
} = require('scorched')
// A singleton for managing state info between suggesters and askers

const {
  SUGGESTER_ADDRESS,
  SCORCHED_ADDRESS,
  CHALLENGE_DURATION,
  ADJUDICATOR_ADDRESS,
  RPC_URL,
  DATA_FILEPATH,
} = process.env

// Types of messages sent
const messageTypes = {
  TEXT: 0,
  CHANNEL_CREATED: 1,
  CHANNEL_SIGNATURE: 2,
  NEW_STATE: 3,
}

const normalizeAddress = (addr) => ethers.utils.getAddress(addr)

class ChannelManager {
  channelIdsByAsker = {}
  channelsById = {}
  latestNonce = 15
  channelListenersById = {}
  provider = undefined

  constructor() {
    // need to start listening to the adjudicator for deposits
    const filepath = path.isAbsolute(DATA_FILEPATH) ? DATA_FILEPATH : path.join(process.cwd(), DATA_FILEPATH)
    this.loadData(filepath)
    setInterval(() => {
      this.saveData(filepath)
    }, 30000)
    this.provider = new ethers.providers.WebSocketProvider(RPC_URL)
    const adjudicator = new ethers.Contract(ADJUDICATOR_ADDRESS, AdjudicatorABI, this.provider)
    adjudicator.on('Deposited', (channelId, asset, amount, nowHeld, tx) => {
      const channel = this.channelsById[channelId]
      if (!channel) return
      setTimeout(async () => {
        try {
          await this.updateBalances(channelId)
        } catch (err) {
          console.log(err)
          console.log('Error updating balances')
        }
      }, 30 * 1000)
    })
  }

  // Load a json file
  loadData(filepath) {
    try {
      if (!fs.existsSync(filepath)) return
      const data = require(filepath)
      const { channelsById, latestNonce } = data
      this.latestNonce = latestNonce
      this.channelsById = channelsById
      this.channelIdsByAsker = Object.keys(channelsById).reduce((acc, channelId) => {
        const channel = channelsById[channelId]
        return {
          ...acc,
          [channel.participants[0]]: channelId,
        }
      }, {})
    } catch (err) {
      console.log(err)
      console.log('Error loading data')
      process.exit(1)
    }
  }

  saveData(filepath) {
    try {
      const data = {
        channelsById: this.channelsById,
        latestNonce: this.latestNonce,
      }
      const dataString = JSON.stringify(data)
      fs.writeFileSync(filepath, dataString)
    } catch (err) {
      console.log(err)
      console.log('Error writing data')
    }
  }

  channel(channelId) {
    return this.channelsById[channelId]
  }

  _createOutcome(balances) {
    const keyedBalances = {}
    for (const address of Object.keys(balances)) {
      keyedBalances[ethers.utils.hexZeroPad(address, 32)] = balances[address]
    }
    const allocation = []
    for (const key of Object.keys(keyedBalances)) {
      allocation.push({
        destination: key,
        amount: keyedBalances[key],
      })
    }
    return [
      {
        asset: ethers.constants.AddressZero,
        assetHolderAddress: ADJUDICATOR_ADDRESS,
        allocationItems: allocation,
      }
    ]
  }

  loadChannels() {
    // arrange the channels by last sent message
    const channels = Object.keys(this.channelIdsByAsker).map((asker) => {
      return this.channelsById[this.channelIdsByAsker[asker]]
    }).sort((a, b) => {
      return a.messages[0]?.timestamp - b.messages[0]?.timestamp
    })
    return channels
  }

  addressBelongsToChannel(address, channelId) {
    const channel = this.channelsById[channelId]
    if (!channel) return false
    const { participants } = channel
    return participants.indexOf(normalizeAddress(address)) !== -1
  }

  channelForAsker(_askerAddress) {
    const askerAddress = normalizeAddress(_askerAddress)
    if (this.channelIdsByAsker[askerAddress]) {
      return this.channelsById[this.channelIdsByAsker[askerAddress]]
    }
    return this.createChannelForAsker(askerAddress)
  }

  createChannelForAsker(_askerAddress) {
    const askerAddress = normalizeAddress(_askerAddress)
    const channelNonce = ++this.latestNonce
    const chainId = 5
    const participants = [askerAddress, normalizeAddress(SUGGESTER_ADDRESS)]
    const channelConfig = {
      chainId,
      channelNonce,
      participants,
    }
    const baseState = {
      isFinal: false,
      channel: channelConfig,
      // outcome: this._createOutcome({
      //   [askerAddress]: 10,
      //   [SUGGESTER_ADDRESS]: 10,
      //   [ethers.constants.AddressZero]: 0,
      // }),
      appDefinition: SCORCHED_ADDRESS,
      appData: ethers.constants.HashZero,
      challengeDuration: CHALLENGE_DURATION ?? 24 * 60 * 60 * 1000,
      turnNum: 0,
    }
    const channelId = getChannelId(channelConfig)
    const channelCreatedMessage = {
      type: messageTypes.CHANNEL_CREATED,
      channelId,
      baseState,
    }
    // suggester needs to sign first, then asker
    const channel = {
      id: channelId,
      participants,
      states: [],
      baseState,
      signatures: [],
      messages: [],
      adjudicatorAddress: ADJUDICATOR_ADDRESS,
      balances: {
        [ethers.constants.AddressZero]: 0,
      }
    }
    this.channelsById[channelId] = channel
    this.channelIdsByAsker[askerAddress] = channelId
    this.sendMessage(channel.id, channelCreatedMessage)
    this.updateBalances(channel.id).catch(err => console.log(err))
    return channel
  }

  async updateBalances(channelId) {
    const channel = this.channelsById[channelId]
    const adjudicator = new ethers.Contract(ADJUDICATOR_ADDRESS, AdjudicatorABI, this.provider)
    const balances = {
      [ethers.constants.AddressZero]: (await adjudicator.holdings(ethers.constants.AddressZero, channelId))
    }
    this.channelsById[channelId].balances = balances
    const listeners = this.channelListenersById[channelId] || []
    for (const fn of listeners) {
      if (!fn) continue
      try {
        fn({ balances })
      } catch (err) {
        console.log(err)
        console.log('Uncaught error in channel listener callback')
      }
    }
  }

  retrieveMessages(channelId, _owner, start, count) {
    const owner = normalizeAddress(_owner)
    if (!this.channelsById[channelId]) return []
    const { messages } = this.channelsById[channelId]
    return messages
  }

  submitSignedState(channelId, state, signature) {
    // TODO verify sig
    const channel = this.channelsById[channelId]
    if (!channel) throw new Error('Channel not found')
    channel.states.push(state)
    channel.signatures.push(signature)
    const listeners = this.channelListenersById[channelId] || []
    for (const fn of listeners) {
      if (!fn) continue
      try {
        fn({ state, signature })
      } catch (err) {
        console.log(err)
        console.log('Uncaught error in channel listener callback')
      }
    }
    this.sendMessage(channelId, {
      text: `State #${state.turnNum} submitted by ${state.turnNum % 2 === 0 ? 'asker' : 'suggester'}!`,
      type: 0,
    })
  }

  sendMessage(channelId, _message) {
    if (typeof _message.type !== 'number') throw new Error('Invalid message type')
    if (!this.channelsById[channelId]) throw new Error('Channel does not exist')
    const message = {
      ..._message,
      timestamp: +new Date(),
    }
    this.channelsById[channelId].messages.unshift(message)
    const listeners = this.channelListenersById[channelId] || []
    for (const fn of listeners) {
      if (!fn) continue
      try {
        fn({ message })
      } catch (err) {
        console.log(err)
        console.log('Uncaught error in channel listener callback')
      }
    }
  }

  listenToChannel(channelId, _owner, cb) {
    const owner = normalizeAddress(_owner)
    if (!this.channelsById[channelId])
      throw new Error('The specific channel does not exist')
    if (typeof cb !== 'function')
      throw new Error('Channel listener callback must be a function')
    if (!this.channelListenersById[channelId])
      this.channelListenersById[channelId] = []
    this.channelListenersById[channelId].push(cb)
    // the id is the index
    return this.channelListenersById[channelId].length - 1
  }

  removeListener(channelId, index) {
    if (!this.channelListenersById[channelId]) return
    this.channelListenersById[channelId][index] = undefined
  }
}

module.exports = new ChannelManager()
