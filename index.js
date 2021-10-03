require('dotenv').config()
const especial = require('especial')

const app = especial()

app.handle('info', (data, send, next) => {
  send({
    contract: '0x',
    suggesterAddress: '0x',
  })
})

const server = app.listen(4000, () => {
  console.log(`Listening on port 4000`)
})
