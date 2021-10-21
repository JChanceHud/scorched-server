import { ethers, BigNumber } from 'ethers'
import path from 'path'
import fs from 'fs'
import {
  getChannelId,
} from '@statechannels/nitro-protocol'
import { AdjudicatorABI } from 'scorched'
// A singleton for managing state info between suggesters and askers

const {
  SCORCHED_ADDRESS,
  CHALLENGE_DURATION,
  ADJUDICATOR_ADDRESS,
  RPC_URL,
  DATA_FILEPATH,
} = process.env

interface ChannelConfig {
  chainId: string
  channelNonce: number
  participants: string[]
}

interface Channel {
  id: string
  participants: string[]
  states: State[]
  baseState: State
  signatures: string[]
  messages: Message[]
  queries: Query[]
  adjudicatorAddress: string,
  balances: { [key: string]: BigNumber | string }
  unreadCount?: number
}

interface Query {
  question: string
  queryAccepted?: boolean
  answer?: string
  // paid or burned?
  answerAccepted?: boolean
}

interface State {
  turnNum: number
  isFinal: boolean
  appDefinition: string
  appData: string
  challengeDuration: number
  channel: ChannelConfig
}

enum MessageType {
  TEXT,
  CHANNEL_CREATED,
  CHANNEL_SIGNATURE,
  NEW_STATE,
}

interface Message {
  timestamp?: number
  type: MessageType
  from?: string
  text?: string
  baseState?: State
}

const normalizeAddress = (addr: string) => ethers.utils.getAddress(addr)

class ChannelManager {
  // A given address might have multiple channel ids with different suggesters/askers
  channelIdsForAsker = {} as { [key: string]: string[] }
  channelIdsForSuggester = {} as { [key: string]: string[] }
  channelsById = {} as { [key: string]: Channel }
  latestNonce = 55
  // for listening to individual channels
  channelListenersById = {}
  // for listening for new channels
  listenersByAddress = {}
  // channelId->address->timestamp
  lastReadByChannelId = {}
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
    const updateBalance = async (channelId: string) => {
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
    }
    adjudicator.on('Deposited', (channelId, asset, amount, nowHeld, tx) => {
      updateBalance(channelId)
    })
    adjudicator.on('Concluded', (channelId, timestamp, tx) => {
      updateBalance(channelId)
    })
  }

  // Load a json file
  loadData(filepath: string) {
    try {
      if (!fs.existsSync(filepath)) return
      const data = require(filepath)
      const { channelsById = {}, latestNonce = 0, lastReadByChannelId = {} } = {
        lastReadByChannelId: {}, // spread a default value for backward compat
        ...data,
      }
      this.latestNonce = latestNonce
      this.channelsById = channelsById
      this.lastReadByChannelId = lastReadByChannelId
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

  saveData(filepath: string) {
    try {
      const data = {
        channelsById: this.channelsById,
        latestNonce: this.latestNonce,
        lastReadByChannelId: this.lastReadByChannelId,
      }
      const dataString = JSON.stringify(data)
      fs.writeFileSync(filepath, dataString)
    } catch (err) {
      console.log(err)
      console.log('Error writing data')
    }
  }

  channel(channelId: string) {
    return this.channelsById[channelId]
  }

  _createOutcome(balances: { [key: string]: BigNumber | string }) {
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

  loadChannels(address: string) {
    // arrange the channels by last sent message
    const allChannelIds = [...(this.channelIdsForAsker[address] || []), ...(this.channelIdsForSuggester[address] || [])]
    const channels = allChannelIds.map((channelId) => {
      return this.channelsById[channelId]
    }).sort((a, b) => {
      return b.messages[0]?.timestamp - a.messages[0]?.timestamp
    })
    for (const channel of channels) {
      channel.unreadCount = this.unreadCount(channel.id, address)
    }
    return channels
  }

  addressBelongsToChannel(address: string, channelId: string) {
    const channel = this.channelsById[channelId]
    if (!channel) return false
    const { participants } = channel
    return participants.indexOf(normalizeAddress(address)) !== -1
  }

  addressIsSuggester(address: string, channelId: string) {
    const channel = this.channelsById[channelId]
    if (!channel) return false
    const { participants } = channel
    return participants.indexOf(normalizeAddress(address)) === 1
  }

  loadOrCreateChannel(_asker: string, _suggester: string) {
    const asker = normalizeAddress(_asker)
    const suggester = normalizeAddress(_suggester)
    // TODO do this in constant time
    const askerChannelIds = this.channelIdsForAsker[asker] || []
    const suggesterChannelIds = this.channelIdsForSuggester[suggester] || []
    const shortestList = askerChannelIds.length > suggesterChannelIds.length ? suggesterChannelIds : askerChannelIds
    for (const channelId of shortestList) {
      const channel = this.channelsById[channelId]
      if (channel.participants[0] === asker && channel.participants[1] === suggester) {
        return channel
      }
    }
    return this.createChannel(asker, suggester)
  }

  createChannel(_askerAddress: string, _suggesterAddress: string) {
    const askerAddress = normalizeAddress(_askerAddress)
    const suggesterAddress = normalizeAddress(_suggesterAddress)
    const channelNonce = ++this.latestNonce
    const chainId = '5'
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
      challengeDuration: +(CHALLENGE_DURATION ?? 24 * 60 * 60 * 1000),
      turnNum: 0,
    }
    const channelId = getChannelId(channelConfig)
    const channelCreatedMessage = {
      type: MessageType.CHANNEL_CREATED,
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
      queries: [],
      adjudicatorAddress: ADJUDICATOR_ADDRESS,
      balances: {
        [ethers.constants.AddressZero]: '0',
      },
    }
    this.channelsById[channelId] = channel
    this.channelIdsForAsker[askerAddress] = [...(this.channelIdsForAsker[askerAddress] || []), channelId]
    this.channelIdsForSuggester[suggesterAddress] = [...(this.channelIdsForSuggester[suggesterAddress] || []), channelId]
    this.sendMessage(channel.id, channelCreatedMessage)
    this.updateBalances(channel.id).catch(err => console.log(err))
    this.newChannelCreated(channel)
    return channel
  }

  async updateBalances(channelId: string) {
    const adjudicator = new ethers.Contract(ADJUDICATOR_ADDRESS, AdjudicatorABI, this.provider)
    const balances = {
      [ethers.constants.AddressZero]: (await adjudicator.holdings(ethers.constants.AddressZero, channelId))
    }
    this.channelsById[channelId].balances = balances
    this.pushChannelUpdate(channelId, { balances })
  }

  createQuery(channelId: string, question: string) {
    const channel = this.channelsById[channelId]
    if (!channel) throw new Error('Channel not found')
    if (!channel.states.length) throw new Error('No channel states exist')
    // make sure we're at a state where a query can be proposed
    if (this.activeQuery(channelId)) throw new Error('Active query already exists')
    channel.queries.push({
      question,
    })
  }

  acceptOrDeclineQuery(channelId: string, accepted: boolean) {
    const activeQuery = this.activeQuery(channelId)
    if (!activeQuery) throw new Error('No active query for channel')
    activeQuery.queryAccepted = accepted
  }

  answerQuery(channelId: string, answer: string) {
    const activeQuery = this.activeQuery(channelId)
    if (!activeQuery) throw new Error('No active query for channel')
    if (activeQuery.queryAccepted !== true) throw new Error('Query has not been accepted')
    if (activeQuery.answer !== undefined) throw new Error('Query has already been answered')
    activeQuery.answer = answer
    this.pushChannelUpdate(channelId, { channel: this.channelsById[channelId] })
  }

  acceptOrDeclineQueryAnswer(channelId: string, accepted: boolean) {
    const activeQuery = this.activeQuery(channelId)
    if (!activeQuery) throw new Error('No active query for channel')
    activeQuery.answerAccepted = accepted
  }

  activeQuery(channelId: string): Query | undefined {
    const channel = this.channelsById[channelId]
    if (!channel) throw new Error('Channel not found')
    if (!channel.queries.length) return
    const latestQuery = channel.queries[channel.queries.length - 1]
    if (
      latestQuery.queryAccepted === undefined ||
      latestQuery.queryAccepted === true && !latestQuery.answer ||
      latestQuery.queryAccepted === true && latestQuery.answerAccepted === undefined
    ) {
      return latestQuery
    }
  }

  retrieveMessages(channelId: string, _owner: string, start: number, count: number) {
    if (!this.channelsById[channelId]) return []
    const { messages } = this.channelsById[channelId]
    return messages
  }

  submitSignedState(channelId: string, state: State, signature: string) {
    // TODO verify sig
    const channel = this.channelsById[channelId]
    if (!channel) throw new Error('Channel not found')
    channel.states.push(state)
    channel.signatures.push(signature)
    this.pushChannelUpdate(channelId, { state, signature })
    this.sendMessage(channelId, {
      text: `State #${state.turnNum} submitted by ${state.turnNum % 2 === 0 ? 'asker' : 'suggester'}!`,
      type: 0,
    })
  }

  pushChannelUpdate(channelId: string, update: any) {
    const listeners = this.channelListenersById[channelId] || []
    for (const fn of listeners) {
      if (!fn) continue
      try {
        if (update.channel && fn.owner) {
          // calculate the unread count
          fn({
            ...update,
            channel: {
              ...update.channel,
              unreadCount: this.unreadCount(channelId, fn.owner)
            }
          })
        } else {
          fn(update)
        }
      } catch (err) {
        console.log(err)
        console.log('Uncaught error in channel listener callback')
      }
    }
  }

  sendMessage(channelId: string, _message: Message) {
    if (typeof _message.type !== 'number') throw new Error('Invalid message type')
    if (!this.channelsById[channelId]) throw new Error('Channel does not exist')
    const message = {
      ..._message,
      timestamp: +new Date(),
    }
    if (message.from) {
      this.markChannelRead(channelId, message.from)
    }
    const channel = this.channelsById[channelId]
    channel.messages.unshift(message)
    this.pushChannelUpdate(channelId, {
      message,
      channel,
    })
  }

  listenToChannel(channelId: string, _owner: string, cb: Function & { owner?: string }) {
    const owner = normalizeAddress(_owner)
    if (!this.channelsById[channelId])
      throw new Error('The specific channel does not exist')
    if (typeof cb !== 'function')
      throw new Error('Channel listener callback must be a function')
    if (!this.channelListenersById[channelId])
      this.channelListenersById[channelId] = []
    ;(cb as any).owner = owner
    this.channelListenersById[channelId].push(cb)
    // the id is the index
    return this.channelListenersById[channelId].length - 1
  }

  removeChannelListener(channelId: string, index: number) {
    if (!this.channelListenersById[channelId]) return
    this.channelListenersById[channelId][index] = undefined
  }

  newChannelCreated(channel: Channel) {
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

  listenForNewChannels(_owner: string, cb: Function) {
    const owner = normalizeAddress(_owner)
    if (typeof cb !== 'function')
      throw new Error('Listener callback must be a function')
    if (!this.listenersByAddress[owner]) {
      this.listenersByAddress[owner] = []
    }
    this.listenersByAddress[owner].push(cb)
    return this.listenersByAddress[owner].length - 1
  }

  removeListener(_owner: string, index: number) {
    const owner = normalizeAddress(_owner)
    if (!this.listenersByAddress[owner]) return
    this.listenersByAddress[owner][index] = undefined
  }

  unreadCount(channelId: string, _address: string) {
    const address = normalizeAddress(_address)
    const channel = this.channelsById[channelId]
    if (!channel)
      throw new Error(`Unable to find channel with id ${channelId}`)
    // calculate the unread count
    if (channel.messages.length === 0) {
      return 0
    }
    const latestRead = (this.lastReadByChannelId[channelId] || {})[address] || 0
    return channel.messages
      .filter((message) => message.timestamp > latestRead).length
  }

  markChannelRead(channelId: string, _address: string) {
    const address = normalizeAddress(_address)
    if (!this.lastReadByChannelId[channelId]) {
      this.lastReadByChannelId[channelId] = {}
    }
    this.lastReadByChannelId[channelId][address] = +new Date()
  }
}

export default new ChannelManager()
