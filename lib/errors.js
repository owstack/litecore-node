'use strict';

var createError = require('errno').create;

var LtcNodeError = createError('LtcNodeError');

var RPCError = createError('RPCError', LtcNodeError);

module.exports = {
  Error: LtcNodeError,
  RPCError: RPCError
};
