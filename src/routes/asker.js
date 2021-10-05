const ChannelManager = require('../channel_manager')

let app
module.exports = (_app) => {
  app = _app
  app.handle('channel.retrieve', loadChannel)
  app.handle('channel.messages', loadChannelMessages)
  app.handle('channel.send', channelSendMessage)
  app.handle('channel.subscribe', channelSubscribe)
}

function loadChannel(data, send, next) {
  if (!data.asker) {
    send(1, 'Invalid asker address')
    return
  }
  const channel = ChannelManager.channelForAsker(data.asker)
  send(channel)
}

function loadChannelMessages(data, send, next) {
  if (!data.asker) {
    send(1, 'Invalid asker address')
    return
  }
  const messages = ChannelManager.retrieveMessages(
    data.channelId,
    data.asker,
    data.start || 0,
    data.count || 50,
  )
  send(messages)
}

function channelSendMessage(data, send, next) {
  ChannelManager.sendMessage(data.channelId, data.message)
  send()
}

function channelSubscribe(data, send, next, ws) {
  const {
    channelId,
    owner,
    subscriptionId,
  } = data
  const id = ChannelManager.listenToChannel(data.channelId, data.owner, (message) => {
    // a message has been received
    app.broadcastOne(subscriptionId, '', message, ws)
  })
  ws.on('close', () => ChannelManager.removeListener(id))
  send()
}
