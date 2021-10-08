const ChannelManager = require('../channel_manager')
const { auth } = require('../middlewares/auth')
const ethers = require('ethers')

const { SUGGESTER_ADDRESS } = process.env

let app
module.exports = (_app) => {
  app = _app
  app.handle('channel.retrieve', auth, loadChannel)
  app.handle('channel.messages', auth, loadChannelMessages)
  app.handle('channel.send', auth, channelSendMessage)
  app.handle('channel.subscribe', auth, channelSubscribe)
  app.handle('channel.submitSignedState', auth, submitSignedState)
}

function submitSignedState(data, send) {
  const { channelId, state, signature } = data
  ChannelManager.submitSignedState(channelId, state, signature)
  send()
}

// return a list of channels
function loadChannel(data, send, next) {
  if (data.auth.address === ethers.utils.getAddress(SUGGESTER_ADDRESS)) {
    console.log('suggester connected')
    const channels = ChannelManager.loadChannels()
    send(channels)
  } else {
    const channel = ChannelManager.channelForAsker(data.auth.address)
    send([channel])
  }
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
    owner,
    subscriptionId,
  } = data
  // TODO: validate subscriptionId uniqueness
  const id = ChannelManager.listenToChannel(data.channelId, data.auth.address, ({
    message,
    state,
    signature,
  }) => {
    // a message has been received
    app.broadcastOne(subscriptionId, '', {
      channelId,
      message,
      state,
      signature,
    }, ws)
  })
  ws.on('close', () => ChannelManager.removeListener(id))
  send()
}
