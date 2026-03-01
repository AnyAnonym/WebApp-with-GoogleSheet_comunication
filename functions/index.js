/* eslint-disable max-len */
const functions = require("firebase-functions");
const {google} = require("googleapis");
// const fetch = require("node-fetch"); // Wichtig, da Firebase Functions kein globales fetch hat
// const serviceAccount = require("./web-with-sheet-70c93-8c8f16c24297.json"); // deine JSON Datei
// const apiKey = "AQ.Ab8RN6Ls_V78v4kwvy4hnTBkxvZUgJrwNYlNqndXtPnlfJQ0pA";
// const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?key=${apiKey}`;


// Beispiel callable Function
exports.sayHello = functions.https.onCall((data, context) => {
  return "Hello WWorld!";
});

// ------------------------------------------------------------

/*
const client = new google.auth.JWT(
    serviceAccount.client_email,
    null,
    serviceAccount.private_key,
    ["https://www.googleapis.com/auth/spreadsheets.readonly"],
);
const sheets = google.sheets({version: "v4", auth: client});
*/

exports.testFunctionJunction = functions.https.onCall(async () => {
  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheets = google.sheets({version: "v4", auth});

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: "1E1CYezDcScIBvH9ebjN0hOkvttTdA6PFIgYKDMaeE04",
      range: "players",
    });

    console.log("Full response from Sheets:", JSON.stringify(res.data, null, 2));
    return {success: true, values: res.data.values || [], range: res.data.range};
  } catch (err) {
    console.error(err);
    return {success: false, error: err.message};
  }
});
