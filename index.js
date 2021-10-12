require('dotenv').config()
const especial = require('especial')
// const ethers = require('ethers')
// const { ScorchedABI } = require('scorched')

const app = especial()

const {
  SCORCHED_ADDRESS,
  ADJUDICATOR_ADDRESS,
  CHALLENGE_DURATION,
} = process.env

// try to load the scorched contract, do some sanity checks
app.handle('info', (data, send, next) => {
  send({
    version: 0,
    contracts: {
      scorched: SCORCHED_ADDRESS,
      adjudicator: ADJUDICATOR_ADDRESS,
    },
  })
})

app.handle('ping', (data, send) => send('pong'))

require('./src/routes/channels')(app)

const server = app.listen(4000, () => {
  console.log(`Listening on port 4000`)
})
