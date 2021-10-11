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
  // A given address might have multiple channel ids with different suggesters/askers
  channelIdsForAsker = {}
  channelIdsForSuggester = {}
  channelsById = {}
  latestNonce = 15
  // for listening to individual channels
  channelListenersById = {}
  // for listening for new channels
  listenersByAddress = {}
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
      const channelIdsByAsker = {}
      const channelIdsBySuggester = {}
      for (const key of Object.keys(channelsById)) {
        const channel = channelsById[key]
        const [ asker, suggester ] = channel.participants
        channelIdsByAsker[asker] = [...(channelIdsByAsker[asker] || []), channel.id]
        channelIdsBySuggester[suggester] = [...(channelIdsBySuggester[suggester]|| []), channel.id]
      }
      this.channelIdsForAsker = channelIdsByAsker
      this.channelIdsForSuggester = channelIdsBySuggester
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

  loadChannels(address) {
    // arrange the channels by last sent message
    const allChannelIds = [...(this.channelIdsForAsker[address] || []), ...(this.channelIdsForSuggester[address] || [])]
    const channels = allChannelIds.map((channelId) => {
      return this.channelsById[channelId]
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

  loadOrCreateChannel(_asker, _suggester) {
    const asker = normalizeAddress(_asker)
    const suggester = normalizeAddress(_suggester)
    // TODO do this in constant time
    const askerChannelIds = this.channelIdsForAsker[asker] || []
    const suggesterChannelIds = this.channelIdsForSuggester[suggester] || []
    const shortestList = askerChannelIds.length > suggesterChannelIds ? suggesterChannelIds : askerChannelIds
    for (const channelId of shortestList) {
      const channel = this.channelsById[channelId]
      if (channel.participants[0] === asker && channel.participants[1] === suggester) {
        return channel
      }
    }
    return this.createChannel(asker, suggester)
  }

  createChannel(_askerAddress, _suggesterAddress) {
    const askerAddress = normalizeAddress(_askerAddress)
    const suggesterAddress = normalizeAddress(_suggesterAddress)
    const channelNonce = ++this.latestNonce
    const chainId = 5
    const participants = [askerAddress, suggesterAddress]
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
    this.channelIdsForAsker[askerAddress] = [...(this.channelIdsForAsker[askerAddress] || []), channelId]
    this.channelIdsForSuggester[suggesterAddress] = [...(this.channelIdsForSuggester[suggesterAddress] || []), channelId]
    this.sendMessage(channel.id, channelCreatedMessage)
    this.updateBalances(channel.id).catch(err => console.log(err))
    this.newChannelCreated(channel)
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

  removeChannelListener(channelId, index) {
    if (!this.channelListenersById[channelId]) return
    this.channelListenersById[channelId][index] = undefined
  }

  newChannelCreated(channel) {
    const [ asker, suggester ] = channel.participants
    const listeners = [
      ...(this.listenersByAddress[asker] || []),
      ...(this.listenersByAddress[suggester] || []),
    ]
    for (const fn of listeners) {
      if (!fn) continue
      try {
        fn({ channel })
      } catch (err) {
        console.log(err)
        console.log('Uncaught error in new channel listener callback')
      }
    }
  }

  listenForNewChannels(_owner, cb) {
    const owner = normalizeAddress(_owner)
    if (typeof cb !== 'function')
      throw new Error('Listener callback must be a function')
    if (!this.listenersByAddress[owner]) {
      this.listenersByAddress[owner] = []
    }
    this.listenersByAddress[owner].push(cb)
    return this.listenersByAddress[owner].length - 1
  }

  removeListener(_owner, index) {
    const owner = normalizeAddress(_owner)
    if (!this.listenersByAddress[owner]) return
    this.listenersByAddress[owner][index] = undefined
  }
}

module.exports = new ChannelManager()
