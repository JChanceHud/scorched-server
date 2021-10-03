require('dotenv').config()
const especial = require('especial')
const ethers = require('ethers')
const { ScorchedABI } = require('scorched')
const ChannelManager = require('./src/channel_manager')

const app = especial()

const {
  SUGGESTER_ADDRESS,
  SCORCHED_ADDRESS,
  ASSET_HOLDER_ADDRESS,
  ADJUDICATOR_ADDRESS,
  CHALLENGE_DURATION,
} = process.env
if (!SUGGESTER_ADDRESS) {
  console.log('No SUGGESTER_ADDRESS configured')
  process.exit(1)
}

// try to load the scorched contract, do some sanity checks

app.handle('info', (data, send, next) => {
  send({
    version: 0,
    contracts: {
      scorched: SCORCHED_ADDRESS,
      assetHolder: ASSET_HOLDER_ADDRESS,
      adjudicator: ADJUDICATOR_ADDRESS,
    },
    suggester: SUGGESTER_ADDRESS,
  })
})

app.handle('channel.retrieve', (data, send, next) => {
  if (!data.asker) {
    send(1, 'Invalid asker address')
    return
  }
  const channel = ChannelManager.channelForAsker(data.asker)
  send(channel)
})

app.handle('channel.messages', (data, send, next) => {
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
})

app.handle('channel.subscribe', (data, send, next, ws) => {
  const {
    channelId,
    owner,
    subscriptionId,
  } = data
  const id = ChannelManager.listenToChannel(data.channelId, data.owner, (message) => {
    // a message has been received
    app.broadcastOne(subscriptionId, message, ws)
  })
  ws.on('close', () => ChannelManager.removeListener(id))
  send()
})

const server = app.listen(4000, () => {
  console.log(`Listening on port 4000`)
})
