'use strict'

// Setup
const rollup = require('rollup').rollup
const dest = 'index.js'

// Main
rollup({entry: 'index-es6.js'}).then((b) => b.write({format: 'cjs', dest}))