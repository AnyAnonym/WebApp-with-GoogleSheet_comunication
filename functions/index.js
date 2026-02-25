// const functions = require("firebase-functions/v2/https");
const functions = require("firebase-functions"); // von YT

// http request 1
exports.randomNumber = functions.https.onRequest((request, response) => {
  const number =Math.round(Math.random()*100);
  response.send(number.toString());
});

// http callable function
exports.sayHello = functions.https.onCall((data, context) => {
  return "Hello World";
});

exports.testFunctionJunction = functions.https.onCall((data, context) => {
  return "Succes!";
});
// ------------------------------------------------------------Chat GPT Code
// const {google} = require("googleapis");

