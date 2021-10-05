const ethers = require('ethers')

const { SUGGESTER_ADDRESS } = process.env

const params = {
  domain: {
    chainId: 5,
    name: 'Scorched Auth',
    version: '0',
  },
  value: {
    info: 'Authenticate',
    details: 'Sign this message to authenticate with the suggester server',
    // timestamp: `${+new Date()}`,
  },
  types: {
    ScorchedAuth: [
      { name: 'info', type: 'string', },
      { name: 'details', type: 'string', },
      { name: 'timestamp', type: 'string', },
    ]
  }
}

function auth(data, send, next) {
  // overwrite any provided auth value
  const auth = { ...(data.auth || {} ) }
  data.auth = {}
  if (!auth.signature) {
    return send('No auth signature provided', 1)
  }
  if (!auth.timestamp) {
    return send('No auth timestamp provided', 1)
  }
  if (!auth.address) {
    return send('No auth address provided', 1)
  }
  // run ecrecover on a provided signature
  const { domain, types, value } = params
  const signer = ethers.utils.verifyTypedData(
    domain,
    types,
    { ...value, timestamp: `${auth.timestamp}` },
    auth.signature
  )
  if (ethers.utils.getAddress(auth.address) !== ethers.utils.getAddress(signer)) {
    send('Signature verification failed', 1)
    return
  }
  data.auth = {
    address: ethers.utils.getAddress(signer),
    timestamp: auth.timestamp,
  }
  next()
}

function requireSuggester(data, send, next) {
  if (!data.auth || !data.auth.address) {
    send('Not authenticated', 1)
    return
  }
  if (ethers.utils.getAddress(SUGGESTER_ADDRESS) !== data.auth.address) {
    send('Not suggester', 1)
    return
  }
  next()
}

module.exports = {
  auth,
  requireSuggester,
}
