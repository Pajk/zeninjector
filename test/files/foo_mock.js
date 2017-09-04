var mock_foo_factory = function() {
	var instance = {};
	instance.get_x = function() { return 150 };
	return instance;
}

//@autoinject
module.exports.foo = mock_foo_factory;