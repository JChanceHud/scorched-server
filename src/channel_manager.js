const ethers = require('ethers')
const {
  getChannelId,
  signState,
  getFiexedPart,
  getVariablePart,
  createOutcome,
} = require('@statechannels/nitro-protocol')
// A singleton for managing state info between suggesters and askers

const {
  SUGGESTER_ADDRESS,
  SCORCHED_ADDRESS,
  CHALLENGE_DURATION,
  ASSET_HOLDER_ADDRESS,
  RPC_URL,
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
  channelIds = {}
  channelIdsByAsker = {}
  channelsById = {}
  latestNonce = 0
  channelListenersById = {}

  constructor(filepath, rpcAddr) {

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
        assetHolderAddress: ASSET_HOLDER_ADDRESS,
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
    const chainId = 4
    const participants = [askerAddress, normalizeAddress(SUGGESTER_ADDRESS)]
    const channelConfig = {
      chainId,
      channelNonce,
      participants,
    }
    const startingState = {
      isFinal: false,
      channel: channelConfig,
      outcome: this._createOutcome({
        [askerAddress]: 10,
        [SUGGESTER_ADDRESS]: 10,
        [ethers.constants.AddressZero]: 0,
      }),
      appDefinition: SCORCHED_ADDRESS,
      appData: ethers.constants.HashZero,
      challengeDuration: CHALLENGE_DURATION ?? 24 * 60 * 60 * 1000,
      turnNum: 0,
    }
    const channelId = getChannelId(channelConfig)
    const channelCreatedMessage = {
      type: messageTypes.CHANNEL_CREATED,
      channelId,
      startingState,
    }
    // suggester needs to sign first, then asker
    const channel = {
      id: channelId,
      participants,
      states: [startingState],
      messages: [],
    }
    this.channelsById[channelId] = channel
    this.channelIdsByAsker[askerAddress] = channelId
    this.sendMessage(channel.id, channelCreatedMessage)
    return channel
  }

  retrieveMessages(channelId, _owner, start, count) {
    const owner = normalizeAddress(_owner)
    if (!this.channelsById[channelId]) return []
    const { messages } = this.channelsById[channelId]
    return messages
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
        fn(message)
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
