'use strict';

var should = require('chai').should();

describe('Index Exports', function() {
  it('will export ltc-lib', function() {
    var ltcLib = require('../');
    should.exist(ltcLib.lib);
    should.exist(ltcLib.lib.Transaction);
    should.exist(ltcLib.lib.Block);
  });
});
