var Container = require('../lib/container');
var assert = require('chai').assert;
var Promise = require('bluebird');
var path = require('path');
var _ = require('lodash');
var sinon = require('sinon');

Promise.onPossiblyUnhandledRejection(function(error){
  // ignore promises which don't handle errors
});

// dummy noop logger here
var logger = {};
['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(function(fn) {
  logger[fn] = function() {}
});

suite('container', function() {
  setup(function() {
    this.container = new Container({logger: logger});
  });

  teardown(function() {
    this.container = null;
  });

  describe('logging', function() {

    test('verbose option', function() {
      sinon.spy(logger, 'debug');
      var container = new Container({
        logger: logger,
        verbose: false
      });
      container.register('a', function() { return 'a'; });

      sinon.assert.notCalled(logger.debug);
      logger.debug.restore();
    });

    test('custom logging', function() {
      var newLogger = _.clone(logger);
      sinon.spy(newLogger, 'debug');
      sinon.spy(logger, 'debug');
      this.container.setLogger(newLogger);
      this.container.options.verbose = true;

      this.container.register('a', function() { return 'a'; });
      sinon.assert.notCalled(logger.debug);
      sinon.assert.called(newLogger.debug);
    });

  });

  suite('register throws error', function() {

    test('with no arguments', function() {
      var container = this.container;
      assert.throw(function() {
        container.register({});
      }, /must have a name/i);
    });

    test('with no function', function() {
      var container = this.container;
      assert.throw(function() {
        container.register('foo');
      }, /must give a function/i);
    });

    test('already registered', function() {
      var container = this.container;
      container.register('first', function() {});
      assert.throw(function() {
        container.register('first', function() {});
      }, /already registered/i);
    });

    test('allow mocks', function(done) {
      var container = new Container({logger: logger, mock_modules: { first: true }});
      var first = function() { return 'orig'; }
      var mock = function () { return 'mock'; }

      container.register('first', mock);
      container.register('first', first);

      container.resolve('first').done(function(resolved) {
        assert.equal(resolved, 'mock');
        done();
      });
    });

  });

  suite('register/resolve', function() {

    test('`resolve` throws error if module is not registered', function(done) {
      this.container.resolve('doesntExist').then(function() {
        done(new Error('Resolve should throw an error'));
      }).catch(function(err) {
        if(/missing dependency/i.test(err.toString())) {
          done();
        } else {
          done(err);
        }
      });
    });

    test('`resolve` throws error when deep dependency is missing', function(done) {
      this.container.register('a', function(b) { return 'a'+b; });
      this.container.register('b', function(c) { return c+'b' });
      this.container.resolve('a').then(function() {
        done(new Error('should throw error'));
      }).catch(function(err) {
        if(/missing dependency/i.test(err.toString())) {
          done();
        } else {
          done(err);
        }
      });
    });

    test('module with no dependencies', function(done) {
      assert.isFalse(this.container.isRegistered('noDep'));
      this.container.register('noDep', function() { return 'nodep'; });
      assert.isTrue(this.container.isRegistered('noDep'));
      this.container.resolve('noDep').done(function(result) {
        assert.equal(result, 'nodep');
        done();
      });
    });

    test('module with a dependency', function(done) {
      var o1 = function() { return 'o1'; }
      var o2 = function(o1) { return o1+' augmented'; }
      this.container.register('o1', o1);
      this.container.register('o2', o2);
      this.container.resolve('o2').done(function(o2Module) {
        assert.equal(o2Module, 'o1 augmented');
        done();
      });

    });

    test('module with an explicit dependency', function(done) {
      var o1 = function() { return 'o1'; }
      var o2 = function(foo) { return foo+' augmented'; }
      this.container.register('o1', o1);
      this.container.register('o2', ['o1', o2]);
      this.container.resolve('o2').done(function(o2Module) {
        assert.equal(o2Module, 'o1 augmented');
        done();
      });
    });

    test('throw error when dependency is not found', function(done) {
      this.container.register('willFail', function(notHere) {return 'ok'; });
      this.container.resolve('willFail').then(function() {;
        done(new Error('resolve should throw an error'));
      }).catch(function(err) {
        done();
      });
    });

    test('do not throw error when `resolve` is called multiple times', function(done) {
      this.container.register('foo', function() { return 'foo'; });
      this.container.register('bar', function(foo) { return foo+'bar'; });
      var first = this.container.resolve('bar');
      var second = this.container.resolve('bar');
      Promise.all([first, second]).nodeify(done);
    });

  });

  test('can register existing objects', function() {
    var fs = require('fs');
    assert.equal(this.container.registerAndExport('fs', fs), fs);
  });

  suite('circular dependencies', function() {

    test('false positive', function(done) {
      this.container.registerAndExport('a', 'a');
      this.container.register('b', function(a) {
        return a+'b';
      });
      this.container.register('c', function(a, b) {
        return a+b+'c';
      });

      this.container.resolve('c').done(function() {
        done();
      });
    });

    test('a -> b -> c -> a throws error', function(done) {
      // a -> b -> c -> a
      this.container.register('a', function(c) { return c+'a'; });
      this.container.register('b', function(a) { return a+'b'; });
      this.container.register('c', function(b) { return b+'c'; });
      this.container.resolve('a').done(function() {
        done(new Error('Should throw an error'));
      }, function(err) {
        if(/circular dependency/i.test(String(err))) {
          done();
        } else {
          done(err);
        }
      });
    });

    test('a -> (b, c), b -> c does not throw', function(done) {
      this.container.register('a', function(b, c) { return 'a'+b+c; });
      this.container.register('b', function(c) { return 'b'+c; });
      this.container.register('c', function() { return 'c'; });
      this.container.resolve('a').then(function() {
        done();
      })
      .catch(done);
    });

    test('a -> a throw error', function(done) {
      this.container.register('a', function(a) { return a; });
      this.container.resolve('a').then(function() {
        done(new Error('should throw an error'));
      })
      .catch(function(err) {
        if(/circular dependency/i.test(String(err))) {
          done();
        } else {
          done(err);
        }
      });
    });

  });

  suite('Inject: manage dependencies', function() {

    test('for anonymous function', function(done) {
      this.container.register('foo', function() { return 'foo'; });
      this.container.inject(function(foo) {
        return foo+foo;
      }).then(function(res) {
        assert.equal(res, 'foofoo');
      }).nodeify(done);
    });

    test('with explicit dependencies', function(done) {
      this.container.register('foo', function() { return 'foo'; });
      this.container.inject(['foo', function(f) {
        return f+f;
      }]).then(function(res) {
        assert.equal(res, 'foofoo');
      }).nodeify(done);
    });

  });

  suite('Scan', function() {

    test('automatically register dependencies', function(done) {
      var that = this;
      this.container.scan(['test/files/module.js'])
      .bind(this)
      .then(function() {
        return this.container.resolve('a');
      })
      .then(function(a) {
        assert.ok(a);
        done();
      })
      .catch(function(err) {
        done(err);
      });
    });

  });

  suite('Mocking', function() {

    test('run foo methods without mocking', function(done) {
      var container = new Container();

      container.scan(['test/files/foo.js'])
      .then(function() {
        return container.resolve('foo');
      })
      .then(function(a) {
        assert.equal(a.get_x(), 1);
        assert.equal(a.get_y(), 2);
        done();
      })
      .catch(function(err) {
        done(err);
      });
    });

    test('enable mocking single function', function(done) {
      var container = new Container({
        mock_modules: {},
        partial_mock_modules: { foo: true }
      });

      container.scan(['test/files/foo_mock.js'])
      .then(function() {
        return container.scan(['test/files/foo.js'])
      })
      .then(function() {
        return container.resolve('foo');
      })
      .then(function(a) {
        assert.equal(a.get_x(), 150);
        assert.equal(a.get_y(), 2);
        done();
      })
      .catch(function(err) {
        done(err);
      });
    });

  });

});
