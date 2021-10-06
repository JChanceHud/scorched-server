require('dotenv').config()
const especial = require('especial')
// const ethers = require('ethers')
// const { ScorchedABI } = require('scorched')

const app = especial()

const {
  SUGGESTER_ADDRESS,
  SCORCHED_ADDRESS,
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
      adjudicator: ADJUDICATOR_ADDRESS,
    },
    suggester: SUGGESTER_ADDRESS,
  })
})

require('./src/routes/asker')(app)
require('./src/routes/suggester')(app)

const server = app.listen(4000, () => {
  console.log(`Listening on port 4000`)
})
