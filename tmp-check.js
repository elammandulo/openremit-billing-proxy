const BillingEngine = require('./src/billing');
const b = new BillingEngine({}, () => {});
console.log(BillingEngine.toString());
console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(b)));
console.log(typeof b.startBillingSession);
