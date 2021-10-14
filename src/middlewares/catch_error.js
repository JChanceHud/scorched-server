function catchError(fn) {
  return async function (...args) {
    const [ , send ] = args
    try {
      await Promise.resolve(fn(...args))
    } catch (err) {
      console.log(err)
      console.log('Uncaught error')
      send('Uncaught error', 1)
    }
  }
}

module.exports = {
  catchError,
}
