const ChannelManager = require('../channel_manager')
const auth = require('../middlewares/auth')

let app
module.exports = (_app) => {
  app = _app
  app.handle('channel.retrieve', auth, loadChannel)
  app.handle('channel.messages', auth, loadChannelMessages)
  app.handle('channel.send', auth, channelSendMessage)
  app.handle('channel.subscribe', auth, channelSubscribe)
}

function loadChannel(data, send, next) {
  const channel = ChannelManager.channelForAsker(data.auth.address)
  send(channel)
}

function loadChannelMessages(data, send, next) {
  const channel = ChannelManager.channelForAsker(data.auth.address)
  if (channel.id !== data.channelId) {
    send(1, 'Not authed for supplied channel id')
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
  const channel = ChannelManager.channelForAsker(data.auth.address)
  if (channel.id !== data.channelId) {
    send(1, 'Not authed for supplied channel id')
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
  const channel = ChannelManager.channelForAsker(data.auth.address)
  if (channel.id !== data.channelId) {
    send(1, 'Not authed for supplied channel id')
    return
  }
  const {
    channelId,
    owner,
    subscriptionId,
  } = data
  const id = ChannelManager.listenToChannel(data.channelId, data.auth.address, (message) => {
    // a message has been received
    app.broadcastOne(subscriptionId, '', message, ws)
  })
  ws.on('close', () => ChannelManager.removeListener(id))
  send()
}
