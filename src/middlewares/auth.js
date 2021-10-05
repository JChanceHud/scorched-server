const ethers = require('ethers')

const domain = {
  chainId: 5,
  name: 'Scorched Auth',
  version: 0,
}
const value = {
  info: 'Authenticate',
  details: 'Sign this message to authenticate with the suggester server',
  // timestamp: `${+new Date()}`,
}
const types = {
  ScorchedAuth: [
    { name: 'info', type: 'string', },
    { name: 'details', type: 'string', },
    { name: 'timestamp', type: 'string', },
  ]
}

module.exports = (data, send, next) => {
  // overwrite any provided auth value
  const auth = { ...(data.auth || {} ) }
  data.auth = {}
  if (!auth.signature) {
    return send('No auth signature provided', 1)
  }
  if (!auth.timestamp) {
    return send('No auth timestamp provided', 1)
  }
  // run ecrecover on a provided signature
  const signer = ethers.utils.verifyTypedData(
    domain,
    types,
    { ...value, timestamp: auth.timestamp },
    auth.signature
  )
  data.auth = {
    address: signer,
    timestamp: auth.timestamp,
  }
  next()
}
