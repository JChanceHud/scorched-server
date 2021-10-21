import ChannelManager from '../channel_manager'
import { auth } from '../middlewares/auth'
import { catchError } from '../middlewares/catch_error'
import { ethers } from 'ethers'
import {
  parseAppData,
  AppStatus,
  QueryStatus,
  ResponseStatus,
} from 'scorched'

let app
module.exports = (_app) => {
  app = _app
  app.handle('channel.create', auth, catchError(createChannel))
  app.handle('channel.retrieve', auth, catchError(loadChannel))
  app.handle('channel.messages', auth, catchError(loadChannelMessages))
  app.handle('channel.markRead', auth, catchError(markChannelRead))
  app.handle('channel.send', auth, catchError(channelSendMessage))
  app.handle('channel.subscribe', auth, catchError(channelSubscribe))
  app.handle('channel.subscribeNewChannels', auth, catchError(subscribeNewChannels))
  app.handle('channel.submitSignedState', auth, catchError(submitSignedState))
  app.handle('channel.submitQueryAnswer', auth, catchError(submitQueryAnswer))
  app.handle('channel.submitQueryQuestion', auth, catchError(submitQueryQuestion))
  app.handle('channel.submitQueryDecline', auth, catchError(submitQueryDecline))
}

function markChannelRead(data, send) {
  const { channelId } = data
  ChannelManager.markChannelRead(channelId, data.auth.address)
  send()
}

function createChannel(data, send) {
  // can only create a channel with someone else as the suggester
  const { suggester } = data
  if (ethers.utils.getAddress(suggester) === data.auth.address) {
    send('Cannot create channel with own address', 1)
    return
  }
  const channel = ChannelManager.loadOrCreateChannel(data.auth.address, suggester)
  send(channel)
}

function submitQueryDecline(data, send) {
  const { channelId } = data
  if (!ChannelManager.addressIsSuggester(data.auth.address, channelId)) {
    send('Not authed as suggester for supplied channel id', 1)
    return
  }
  // decline the query
  ChannelManager.acceptOrDeclineQuery(channelId, false)
  send()
}

function submitQueryQuestion(data, send) {
  const { channelId, question } = data
  if (ChannelManager.addressIsSuggester(data.auth.address, channelId)) {
    send('Not authed as asker for supplied channel id', 1)
    return
  }
  ChannelManager.createQuery(channelId, question)
  send()
}

function submitQueryAnswer(data, send) {
  const { channelId, answer } = data
  if (!ChannelManager.addressIsSuggester(data.auth.address, channelId)) {
    send('Not authed as suggester for supplied channel id', 1)
    return
  }
  ChannelManager.answerQuery(channelId, answer)
  send()
}

function submitSignedState(data, send) {
  const {
    channelId,
    state,
    signature,
  } = data
  if (!ChannelManager.addressBelongsToChannel(data.auth.address, channelId)) {
    send('Not authed for supplied channel id', 1)
    return
  }
  // if the state is proposing a query rate we need a question to go with it
  try {
    const {
      status,
      queryStatus,
      responseStatus
    } = parseAppData(state.appData)
    // we have an active query, decode the app data and update the query info
    if (status === AppStatus.Answer) {
      // suggester has accepted the query, now awaiting answer
      ChannelManager.acceptOrDeclineQuery(channelId, queryStatus === QueryStatus.Accepted)
    } else if (status === AppStatus.Validate) {
      ChannelManager.acceptOrDeclineQueryAnswer(channelId, responseStatus === ResponseStatus.Pay)
    }
  } catch (err) {
    console.log(err)
    console.log('Error processing query data')
  }
  ChannelManager.submitSignedState(channelId, state, signature)
  send()
}

// return a list of channels
function loadChannel(data, send, next) {
  const channels = ChannelManager.loadChannels(data.auth.address)
  send(channels)
}

function loadChannelMessages(data, send, next) {
  if (!ChannelManager.addressBelongsToChannel(data.auth.address, data.channelId)) {
    send('Not authed for supplied channel id', 1)
    return
  }
  const messages = ChannelManager.retrieveMessages(
    data.channelId,
    data.auth.address,
    data.start || 0,
    data.count || 50,
  )
  send(messages)
}

function channelSendMessage(data, send, next) {
  if (!ChannelManager.addressBelongsToChannel(data.auth.address, data.channelId)) {
    send('Not authed for supplied channel id', 1)
    return
  }
  if (typeof data.message !== 'object') {
    send('Message should be object', 1)
    return
  }
  ChannelManager.sendMessage(data.channelId, {
      ...data.message,
      from: data.auth.address,
    }
  )
  send()
}

function channelSubscribe(data, send, next, ws) {
  if (!ChannelManager.addressBelongsToChannel(data.auth.address, data.channelId)) {
    send('Not authed for supplied channel id', 1)
    return
  }
  const {
    channelId,
    subscriptionId,
  } = data
  // TODO: validate subscriptionId uniqueness
  const id = ChannelManager.listenToChannel(data.channelId, data.auth.address, (args) => {
    // a message has been received
    app.broadcastOne(subscriptionId, '', {
      channelId,
      ...args,
    }, ws)
  })
  ws.on('close', () => ChannelManager.removeChannelListener(channelId, id))
  send()
}

function subscribeNewChannels(data, send, next, ws) {
  const {
    subscriptionId,
  } = data
  const address = data.auth.address
  const id = ChannelManager.listenForNewChannels(address, (args) => {
    app.broadcastOne(subscriptionId, '', args, ws)
  })
  ws.on('close', () => ChannelManager.removeListener(address, id))
  send()
}
