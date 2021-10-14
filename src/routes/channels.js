const ChannelManager = require('../channel_manager')
const { auth } = require('../middlewares/auth')
const { catchError } = require('../middlewares/catch_error')
const ethers = require('ethers')

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

function submitSignedState(data, send) {
  const { channelId, state, signature } = data
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
