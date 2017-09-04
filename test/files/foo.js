var foo_factory = function() {
	var x = 1;
	var y = 2;

	var instance = {};

	instance.get_x = function() { return x }
	instance.get_y = function() { return y }

	return instance;
}

//@autoinject
module.exports.foo = foo_factory;