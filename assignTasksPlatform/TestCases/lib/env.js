'use strict';
// Where the app under test lives and how fast simulated time runs.
// Override with environment variables; nothing here reads the app's code.
const path = require('node:path');

const APP_DIR = path.resolve(process.env.APP_DIR || path.join(__dirname, '..', '..', 'GoldRef'));
const SERVER_ENTRY = process.env.SERVER_ENTRY || path.join('src', 'server.js');
const HOST = process.env.TEST_HOST || 'localhost';
// Simulated seconds per real second. Every test is written in simulated seconds.
const SPEED = Number(process.env.TEST_SPEED || 10);

module.exports = { APP_DIR, SERVER_ENTRY, HOST, SPEED };
