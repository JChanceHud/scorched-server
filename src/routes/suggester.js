const ChannelManager = require('../channel_manager')
const { auth, requireSuggester } = require('../middlewares/auth')

module.exports = (app) => {
  app.handle('suggester.channels', auth, requireSuggester, loadChannels)
  app.handle('suggester.channel.send', auth, requireSuggester, sendMessage)
}

function loadChannels(data, send) {
  const channels = ChannelManager.loadChannels()
  send(channels)
}

function sendMessage(data, send) {
  ChannelManager.sendMessage(data.channelId, {
    ...data.message,
    from: data.auth.address,
  })
  send()
}
