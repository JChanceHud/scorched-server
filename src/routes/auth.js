module.exports = (app) => {
  app.handle('auth.challenge', generateChallenge)
}

function generateChallenge(data, send, next) {
  const msgParams = JSON.stringify({
    domain: {
      chainId: 5,
      name: 'Scorched Auth',
      version: '0',
    },
    message: {
      info: 'Authenticate',
      details: 'Sign this message to authenticate with the suggester server',
      timestamp: +new Date(),
    },
    primaryType: 'ScorchedAuth',
    types: {
      ScorchedAuth: [
        { name: 'info', type: 'string', },
        { name: 'details', type: 'string', },
        { name: 'timestamp', type: 'number', },
      ]
    }
  })
  send(msgParams)
}
