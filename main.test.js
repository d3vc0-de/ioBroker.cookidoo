'use strict';

/**
 * This is a dummy TypeScript test file using chai and mocha
 *
 * It's automatically excluded from npm and its build output is excluded from both git and npm.
 * It is advised to test all your modules with accompanying *.test.js-files
 */

const { expect } = require('chai');
// import { functionToTest } from "./moduleToTest";

describe('dummy test', () => {
	it('should pass', () => {
		expect(true).to.equal(true);
	});
});
