'use strict';

var async = require('async');
var BaseService = require('../../service');
var inherits = require('util').inherits;
var Encoding = require('./encoding');
var index = require('../../');
var log = index.log;
var utils = require('../../utils');
var assert = require('assert');
var constants = require('../../constants');
var bcoin = require('bcoin');
var _ = require('lodash');

var BlockService = function(options) {

  BaseService.call(this, options);

  this._tip = null;
  this._db = this.node.services.db;
  this._p2p = this.node.services.p2p;
  this._header = this.node.services.header;
  this._timestamp = this.node.services.timestamp;

  this._subscriptions = {};
  this._subscriptions.block = [];

  this._blockCount = 0;
  this.GENESIS_HASH = constants.BITCOIN_GENESIS_HASH[this.node.network];
  this._initialSync = true;
};

inherits(BlockService, BaseService);

BlockService.dependencies = [ 'timestamp', 'p2p', 'db', 'header' ];

// --- public prototype functions
BlockService.prototype.getAPIMethods = function() {
  var methods = [
    ['getInfo', this, this.getInfo, 0],
    ['getBlock', this, this.getBlock, 1],
    ['getRawBlock', this, this.getRawBlock, 1],
    ['getBlockOverview', this, this.getBlockOverview, 1],
    ['getBestBlockHash', this, this.getBestBlockHash, 0],
    ['syncPercentage', this, this.syncPercentage, 0],
    ['isSynced', this, this.isSynced, 0]
  ];
  return methods;
};

BlockService.prototype.getInfo = function(callback) {
  var self = this;

  callback(null, {
    blocks: self.getTip().height,
    connections: self._p2p.getNumberOfPeers(),
    timeoffset: 0,
    proxy: '',
    testnet: self.node.network === 'livenet' ? false: true,
    errors: '',
    network: self.node.network,
    relayFee: 0,
    version: 'bitcore-1.1.2',
    protocolversion: 700001,
    difficulty: self._header.getCurrentDifficulty()
  });
};

BlockService.prototype.isSynced = function(callback) {
  callback(null,  !this._initialSync);
};

BlockService.prototype.getBestBlockHash = function(callback) {
  var hash = this._header.getLastHeader().hash;
  callback(null, hash);
};

BlockService.prototype.getTip = function() {
  return this._tip;
};

BlockService.prototype.getBlock = function(arg, callback) {

  var self = this;
  self._getHash(arg, function(err, hash) {

    if (err) {
      return callback(err);
    }

    if (!hash) {
      return callback();
    }

    self._getBlock(hash, callback);
  });

};

BlockService.prototype.getBlockOverview = function(hash, callback) {

  var self = this;
  self._getBlock(hash, function(err, block) {

    if (err) {
      return callback(err);
    }

    if (!block) {
      return callback();
    }

    self._header.getBlockHeader(hash, function(err, header) {

      if (err) {
        return callback(err);
      }

      var target = bcoin.mining.common.getTarget(header.bits);
      var difficulty = bcoin.mining.common.getDifficulty(target);
      var txids = block.txs.map(function(tx) {
        return tx.txid();
      });

      var blockOverview = {
        hash: block.rhash(),
        version: block.version,
        confirmations: self.getTip().height - header.height + 1,
        height: header.height,
        chainWork: header.chainwork,
        prevHash: header.prevHash,
        nextHash: null,
        merkleRoot: header.merkleRoot,
        time: block.ts,
        medianTime: null,
        nonce: header.nonce,
        bits: header.bits,
        difficulty: difficulty,
        txids: txids
      };

      callback(null, blockOverview);
    });
  });

};

BlockService.prototype.getPublishEvents = function() {

  return [
    {
      name: 'block/block',
      scope: this,
      subscribe: this.subscribe.bind(this, 'block'),
      unsubscribe: this.unsubscribe.bind(this, 'block')
    }
  ];

};

BlockService.prototype.getRawBlock = function(hash, callback) {
  this.getBlock(hash, function(err, block) {
    if(err) {
      return callback(err);
    }
    callback(null, block.toRaw().toString('hex'));
  });
};

BlockService.prototype._checkTip = function(callback) {

  var self = this;

  self._header.getBlockHeader(self._tip.height, function(err, header) {

    if (err) {
      return callback(err);
    }

    header = header || self._header.getLastHeader();

    if (header.hash === self._tip.hash) {
      log.info('Block Service: saved tip is good to go.');
      return callback();
    }

    self._findCommonAncestor(function(err, commonAncestorHash) {
      if(err) {
        return callback(err);
      }
      self._handleReorg(commonAncestorHash, callback);
    });

  });
};

BlockService.prototype._findCommonAncestor = function(callback) {

  var self = this;
  var hash = self._tip.hash;

  self._header.getAllHeaders(function(err, headers) {

    if(err || !headers) {
      return callback(err || new Error('headers required.'));
    }

    async.until(function() {
      return headers.get(hash);
    }, function(next) {
      self._getBlock(hash, function(err, block) {
        if(err) {
          return next(err);
        }
        hash = bcoin.util.revHex(block.prevBlock);
        next();
      });
    }, function(err) {
      if(err) {
        return callback(err);
      }
      callback(null, hash);
    });
  });
};

BlockService.prototype.start = function(callback) {

  var self = this;

  async.waterfall([
    function(next) {
      self._db.getPrefix(self.name, next);
    },
    function(prefix, next) {
      self._prefix = prefix;
      self._encoding = new Encoding(self._prefix);
      self._db.getServiceTip('block', next);
    }
  ], function(err, tip) {

    if(err) {
      return callback(err);
    }

    self._blockProcessor = async.queue(self._onBlock.bind(self));

    self._setListeners();
    assert(tip.height >= 0, 'tip is not initialized');
    self._setTip(tip);
    self._bus = self.node.openBus({remoteAddress: 'localhost-block'});
    callback();

  });

};

BlockService.prototype.stop = function(callback) {
  setImmediate(callback);
};

BlockService.prototype.subscribe = function(name, emitter) {
  this._subscriptions[name].push(emitter);
  log.info(emitter.remoteAddress, 'subscribe:', 'block/' + name, 'total:', this._subscriptions[name].length);
};

BlockService.prototype._queueBlock = function(block) {

  var self = this;

  self._blockProcessor.push(block, function(err) {

    if (err) {
      return self._handleError(err);
    }

    log.debug('Block Service: completed processing block: ' + block.rhash() +
      ' prev hash: ' + bcoin.util.revHex(block.prevBlock) + ' height: ' + self._tip.height);

  });

};

BlockService.prototype._syncPercentage = function() {
  var height = this._header.getLastHeader().height;
  var ratio = this._tip.height/height;
  return (ratio*100).toFixed(2);
};

BlockService.prototype.syncPercentage = function(callback) {
  callback(null, this._syncPercentage());
};

BlockService.prototype.unsubscribe = function(name, emitter) {

  var index = this._subscriptions[name].indexOf(emitter);

  if (index > -1) {
    this._subscriptions[name].splice(index, 1);
  }

  log.info(emitter.remoteAddress, 'unsubscribe:', 'block/' + name, 'total:', this._subscriptions[name].length);

};

// --- start private prototype functions

BlockService.prototype._broadcast = function(subscribers, name, entity) {
  for (var i = 0; i < subscribers.length; i++) {
    subscribers[i].emit(name, entity);
  }
};

BlockService.prototype._detectReorg  = function(block) {
  return bcoin.util.revHex(block.prevBlock) !== this._tip.hash;
};

BlockService.prototype._getBlock = function(hash, callback) {

  var self = this;

  this._db.get(this._encoding.encodeBlockKey(hash), function(err, data) {

    if(err) {
      return callback(err);
    }

    if (!data) {
      return callback();
    }

    var block = self._encoding.decodeBlockValue(data);
    callback(null, block);

  });
};

BlockService.prototype._getHash = function(blockArg, callback) {

  if (utils.isHeight(blockArg)) {

    this._header.getHeaderByHeight(blockArg, function(err, header) {

      if(err) {
        return callback(err);
      }

      if (!header) {
        return callback();
      }

      callback(null, header.hash);
    });

  }

  return callback(null, blockArg);

};

BlockService.prototype.onReorg = function(args, callback) {

  var self = this;

  var block = args[1][0];

  self._setTip({ hash: block.rhash(), height: self._tip.height - 1 });
  var tipOps = utils.encodeTip(self._tip, self.name);

  var removalOps = [{
    type: 'put',
    key: tipOps.key,
    value: tipOps.value
  }];

  removalOps.push({
    type: 'del',
    key: self._encoding.encodeBlockKey(block.rhash()),
  });

  setImmediate(function() {
    callback(null, removalOps);
  });
};

BlockService.prototype._onReorg = function(commonAncestorHash, block, callback) {

  var self = this;
  var services = self.node.services;

  async.mapSeries(services, function(service, next) {

    if(!service.onReorg) {
      return setImmediate(next);
    }

    service.onReorg.call(service, [commonAncestorHash, [block]], next);

  }, callback);

};

BlockService.prototype._removeAllSubscriptions = function() {
  this._bus.unsubscribe('p2p/block');
  this._bus.removeAllListeners();
  this._subscribedBlock = false;
};

BlockService.prototype.onHeaders = function(callback) {

  var self = this;

  async.retry(function(next) {

    next(self._blockProcessor.length() !== 0);

  }, function() {

    self._checkTip(function(err) {

      if(err) {
        return callback(err);
      }

      self._startSync();
      callback();

    });
  });

};

BlockService.prototype._startBlockSubscription = function() {

  if (this._subscribedBlock) {
    return;
  }

  this._subscribedBlock = true;

  log.info('Block Service: starting p2p block subscription.');
  this._bus.on('p2p/block', this._queueBlock.bind(this));
  this._bus.subscribe('p2p/block');

};

BlockService.prototype._handleReorg = function(commonAncestorHash, callback) {

  var self = this;

  log.warn('Block Service: chain reorganization detected, current height/hash: ' + self._tip.height + '/' +
    self._tip.hash + ' common ancestor hash: ' + commonAncestorHash);

  var operations = [];
  var tip = self._tip;
  var blockCount = 0;

  // we don't know how many blocks we need to remove until we've reached the common ancestor
  async.whilst(
    function() {
      return tip.hash !== commonAncestorHash;
    },

    function(next) {
      async.waterfall([

        self._getReorgBlock.bind(self, tip),

        function(block, next) {
          tip = {
            hash: bcoin.util.revHex(block.prevBlock),
            height: tip.height - 1
          };
          next(null, block);
        },

        function(block, next) {
          self._onReorg(commonAncestorHash, block, next);
        }

      ], function(err, ops) {
        if(err) {
          return next(err);
        }
        blockCount++;
        operations = operations.concat(ops);
        next();
      });
    },

    function(err) {

      if (err) {
        return callback(err);
      }

      log.info('Block Service: removed ' + blockCount + ' block(s) during the reorganization event.');
      self._db.batch(_.compact(_.flattenDeep(operations)), callback);

    });
};

BlockService.prototype._getReorgBlock = function(tip, callback) {

  var self = this;

  self._getBlock(tip.hash, function(err, block) {

    if (err || !block) {
      return callback(err || new Error('block not found for reorg.'));
    }

    self._timestamp.getTimestamp(tip.hash, function(err, timestamp) {

      if (err || !timestamp) {
        return callback(err || new Error('timestamp missing from reorg.'));
      }

      block.__height = tip.height;
      block.__ts = timestamp;
      callback(null, block);
    });

  });

};

BlockService.prototype._onBlock = function(block, callback) {

  var self = this;
  self._getBlock(block.rhash(), function(err, _block) {

    if(err) {
      return self._handleError(err);
    }

    if (_block) {
      log.debug('Block Service: not syncing, block already in database.');
      return setImmediate(callback);
    }

    self._processBlock(block, callback);

  });
};

BlockService.prototype._processBlock = function(block, callback) {

  var self = this;

  if (self.node.stopping) {
    return callback();
  }

  log.debug('Block Service: new block: ' + block.rhash());

  // common case
  if (!self._detectReorg(block)) {
    return setImmediate(function() {
      self._saveBlock(block, callback);
    });
  }

  // reorg
  self._handleReorg(bcoin.util.revHex(block.prevBlock), function(err) {
    if(err) {
      return callback(err);
    }
    self._saveBlock(block, callback);
  });

};

BlockService.prototype._saveBlock = function(block, callback) {

  var self = this;
  block.__height = self._tip.height + 1;

  var services = self.node.services;

  async.mapSeries(services, function(service, next) {

    if(!service.onBlock) {
      return setImmediate(next);
    }

    service.onBlock.call(service, block, next);

  }, function(err, ops) {
    if (err) {
      return callback(err);
    }

    self._db.batch(_.compact(_.flattenDeep(ops)), function(err) {
      if (err) {
        return callback(err);
      }

      self._setTip({ hash: block.rhash(), height: self._tip.height + 1 });
      var tipOps = utils.encodeTip(self._tip, self.name);

      self._db.put(tipOps.key, tipOps.value, function(err) {
        if(err) {
          return callback(err);
        }
        callback();
      });
    });
  });
};

BlockService.prototype._onBestHeight = function(height) {
  log.info('Block Service: Best Height is: ' + height);
  this._removeAllSubscriptions();
};

BlockService.prototype._setListeners = function() {
  this._p2p.on('bestHeight', this._onBestHeight.bind(this));
};

BlockService.prototype._handleError = function(err) {
  if (!this.node.stopping) {
    log.error('Block Service: ' + err);
    return this.node.stop();
  }
};

BlockService.prototype._syncBlock = function(block) {
  var self = this;

  self._saveBlock(block, function(err) {
    if(err) {
      return self._handleError(err);
    }
    if (self._tip.height < self._header.getLastHeader().height) {
      return self.emit('next block');
    }
    self.emit('synced');
  });
};

BlockService.prototype.onBlock = function(block, callback) {
  var self = this;

  setImmediate(function() {
    callback(null, [{
      type: 'put',
      key: self._encoding.encodeBlockKey(block.rhash()),
      value: self._encoding.encodeBlockValue(block)
    }]);
  });
};

BlockService.prototype._setTip = function(tip) {
  log.debug('Block Service: Setting tip to height: ' + tip.height);
  log.debug('Block Service: Setting tip to hash: ' + tip.hash);
  this._tip = tip;
};

BlockService.prototype._onSynced = function() {
  var self = this;
  self._logProgress();
  self._initialSync = false;
  self._startBlockSubscription();
  log.info('Block Service: The best block hash is: ' + self._tip.hash +
    ' at height: ' + self._tip.height);
};

BlockService.prototype._startSync = function() {

  var numNeeded = Math.max(this._header.getLastHeader().height - this._tip.height, 0);

  log.info('Block Service: Gathering: ' + numNeeded + ' block(s) from the peer-to-peer network.');

  if (numNeeded > 0) {
    this.on('next block', this._sync.bind(this));
    this.on('synced', this._onSynced.bind(this));
    return this._sync();
  }

  this._onSynced();

};

BlockService.prototype._sync = function() {

  var self = this;

  if (self.node.stopping) {
    return;
  }

  if (self._tip.height % 144 === 0) {
    self._logProgress();
  }

  self._header.getNextHash(self._tip, function(err, targetHash, nextHash) {

    if(err) {
      return self._handleError(err);
    }

    // to ensure that we can receive blocks that were previously delivered
    // this will lead to duplicate transactions being sent
    self._p2p.clearInventoryCache();

    self._p2p.getP2PBlock({
      filter: {
        startHash: self._tip.hash,
        endHash: nextHash
      },
      blockHash: targetHash
    }, self._syncBlock.bind(self));

  });

};

BlockService.prototype._logProgress = function() {

  if (!this._initialSync) {
    return;
  }

  var progress;
  var bestHeight = Math.max(this._header.getBestHeight(), this._tip.height);

  if (bestHeight === 0) {
    progress = 0;
  } else {
    progress = (this._tip.height/bestHeight*100.00).toFixed(2);
  }

  log.info('Block Service: download progress: ' + this._tip.height + '/' +
    bestHeight + '  (' + progress + '%)');

};

module.exports = BlockService;