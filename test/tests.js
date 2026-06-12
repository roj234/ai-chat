import {testRunner} from "./index.js";

testRunner.push(() => {
	return 1+1 === 2;
}, "1+1 = 2");

testRunner.push(() => {
	return 1+2 === 2;
}, "1+2 = 2");