'use strict';

var Promise = require('bluebird');
var _ = require('lodash');
var multiGlob = require('multi-glob');
var fs = require('fs');

var parser = require('./parser');
var extractor = require('./extractDep');
var detectCycle = require('./cycleDetection').detectCycle;

var Container = function(options) {
  this._modules = {};
  this._partial_modules = {};
  this._cycles = undefined;

  this.options = options || {};
  this.logger = this.options.logger;
  if(!this.logger) {
    this.logger = console;
    console.debug = console.debug || console.log;
    console.trace = console.trace || console.log;
  }
};

Container.prototype.setLogger = function setLogger(logger) {
  this.logger = logger;
  return this;
}

// Represent an object to be registered.
// The given hash should have the following keys:
//   name: (string)
//   dependencies (array of string): optional
//   define: the function to call when resolving the module
// It can be in 3 states:
//   registered: the initial state
//   resolving: when its dependencies are being resolved
//   resolved: it's `define` function has returned
var Module = function(module) {

  if(!module || typeof module !== 'object') {
    throw new Error('Invalid module: '+JSON.stringify(module));
  }

  if(!module.name) {
    throw new Error('Module must have a name');
  }

  if(!module.define || typeof module.define !== 'function') {
    throw new Error('Module ('+module.name+') must have a `define` function');
  }

  this.name = module.name;
  this.dependencies = module.dependencies || [];
  this.define = module.define;
  this.state = 'registered';
  this.exported = null;
}

// takes a function or an array
// [String, ..., String, function]
// and returns the list of dependencies and the
// function
function extractDependencies(deps) {
  var dependencies, fn;
  if('function' === typeof deps) {
    fn = deps;
    dependencies = extractor(fn);
  } else {
    dependencies = deps.slice(0, -1);
    fn = deps[deps.length-1];
  }
  return {
    dependencies: dependencies,
    fn: fn
  }
}

// Register a module
// @params {String} name: the unique name
// @params {Array<String..., Function> / Function} deps:
// This parameter can be a function or an array of string with the last
// element of the array to be the function to register the module
// If it's a function, the dependencies will be guessed from the code of
// the function (see extractor)
Container.prototype.register = function(name, deps) {
  if(this.options.verbose) this.logger.debug('registering %s', name);

  // invalidate any cycle detection done so far
  this._cycles = undefined;

  if(!name || 'string' !== typeof name) {
    throw new Error('Must have a name');
  }

  if(!deps) {
    throw new Error('Must give a function for module '+name);
  }

  var extracted = extractDependencies(deps);
  var dependencies = extracted.dependencies;
  var fn = extracted.fn;

  if('function' !== typeof fn) {
    throw new Error('Must give a function for module '+name);
  }

  if(this._modules[name]) {
    if((typeof this.options.mock_modules) === 'object' && this.options.mock_modules[name]) {
      return;
    } else if ((typeof this.options.partial_mock_modules) === 'object' && this.options.partial_mock_modules[name]) {
      this._partial_modules[name] = this._modules[name];
    } else {
      throw new Error(name+' already registered');
    }
  }

  this._modules[name] = new Module({
    name: name,
    dependencies: dependencies,
    define: fn
  });

  return;
};

Container.prototype.isRegistered = function(moduleName) {
  return !!this._modules[moduleName];
}

// Method to register an already existing object, typically an npm module
// or an object coming from the outside
// container.registerAndExport('fs', require('fs'));
Container.prototype.registerAndExport = function(name, obj) {
  this.register(name, function() { return obj; });
  this._modules[name].state = 'resolved';
  this._modules[name].exported = obj;
  return obj;
};

Container.prototype.resolve = function(name, partial = false) {
  var module;

  if (partial == false) {
    module = this._modules[name];
  } else {
    module = this._partial_modules[name];
  }

  if(!module) {
    return Promise.reject(new Error('Missing dependency `'+name+'`'));
  }

  if(module.state === 'resolved') {
    if(this.options.verbose) this.logger.debug('%s resolved from cache', name);
    return Promise.resolve(module.exported);
  }

  try {
    module.dependencies.forEach(function(dep) {
      if( !this._modules[dep] ) {
        this.logger.warn('Dependency %s not found for %s', dep, name);
        throw new Error('Dependency not found '+dep+' for module '+name);
      }
    }, this);
  } catch(err) {
    return Promise.reject(err);
  }


  if(!this._cycles) {
    try {
      this._cycles = detectCycle(this._modules);
    } catch(err) { return Promise.reject(err); }
  }
  var cycles = this._cycles;

  if(cycles.length) {
    var prettyCycles = cycles.map(function(cycle) {
      var start = cycle[0];
      var prettyCycle = cycle.map(function(m) { return m.name; });
      prettyCycle.push(start.name);
      prettyCycle = prettyCycle.join(' -> ');
      return prettyCycle;
    }).join('\n');
    return Promise.reject(new Error(
      'Circular dependency detected with '+name+':\n'+prettyCycles
    ));
  }

  if(module.state === 'resolving') {
    return module.resolvingPromise;
  }

  module.state = 'resolving';

  var container = this;
  var dependencies = module.dependencies.map(function(dep) {
    return this._modules[dep];
  }, this).map(function (dep) {
    if(dep.state || dep.state === 'registered') {
      return container.resolve(dep.name);
    } else {
      return dep.exported;
    }
  });

  module.resolvingPromise = Promise.all(dependencies)
  .bind(this)
  .then(function(deps) {
    var exported = Promise.try(module.define, deps);
    module.state = 'resolved';
    module.exported = exported;
    this._modules[name] = module;
    if(this.options.verbose) this.logger.debug('%s resolved', name);
    return exported
  });

  if (this._partial_modules[name] && partial == false) {
    var resolved_partial_module;
    return this.resolve(name, true)
    .then((resolved_partial) => {
      resolved_partial_module = resolved_partial;
      return Promise.resolve(module.resolvingPromise);
    }).then((resolved_module) => {
      this.performPartialMock(resolved_module, resolved_partial_module);
      return resolved_module
    });
  } else {
    return module.resolvingPromise;
  }
};

Container.prototype.performPartialMock = function (original_module, partial_module) {
  Object.keys(original_module).map((key) => {
    if (partial_module[key] != undefined) {
      original_module[key] = partial_module[key]
    }
  })
};

// Manage dependencies for an anonymous function
// with an optional given context
Container.prototype.inject = function(fn, ctx) {
  if(!fn) return;
  var extracted = extractDependencies(fn);
  var dependencies = extracted.dependencies;
  fn = extracted.fn;

  dependencies = dependencies.map(function(dep) {
    return this.resolve(dep);
  }, this);

  return Promise.all(dependencies)
  .then(function(deps) {
    return fn.apply(ctx, deps);
  });

}

Container.prototype.scan = function(options, patterns) {
  if(!patterns) {
    patterns = options;
    options = {}
  }

  var files = Promise.promisify(multiGlob.glob)(patterns, options);

  var that = this;

  function registerFromFile(file) {
      var modules = parser.extractModulesFromFile(file);
      return modules.map(function(module) {
          that.register(module.name, module.define);
      })
      .all()
      .catch(function(err) {
          console.error('got error while processing file %s', file, err);
          throw err;
      });
  }
  return files.map(registerFromFile).all();
}

Container.prototype.saveGraphToFile = function (path, ignoreList) {
  var prefix = 'digraph DI { ';
  var suffix = ' }';
  var dependencies;

  var ignoreListFilter = function (dep) {
    return _.includes(ignoreList, dep) == false;
  }

  var sortedModules = _.sortBy(this._modules, 'name');

  var dotGraphSource = _.reduce(sortedModules, function (str, module) {
    dependencies = ignoreList ? _.filter(module.dependencies, ignoreListFilter) : module.dependencies;
    return str + module.name + ' -> { ' + dependencies.join(' ') + ' } ';
  }, prefix) + suffix;

  fs.writeFile(path, dotGraphSource);
}

module.exports = Container;
