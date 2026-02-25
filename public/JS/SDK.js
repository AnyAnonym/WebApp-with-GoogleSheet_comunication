// SDK.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-analytics.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-functions.js";
// (You can also import getFirestore, getDatabase, etc. if needed)

const firebaseConfig = {
  apiKey: "AIzaSyDjJ7BY1SkBl4YlYCuqwKYQIWZKCL1cD2A",
  authDomain: "web-with-sheet-70c93.firebaseapp.com",
  databaseURL: "https://web-with-sheet-70c93-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "web-with-sheet-70c93",
  storageBucket: "web-with-sheet-70c93.firebasestorage.app",
  messagingSenderId: "1035083483140",
  appId: "1:1035083483140:web:122dc8d81a2519cc744d51",
  measurementId: "G-RZPK2HKV0S"
};

// Initialize once
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const functions = getFunctions(app);

// Export what other files may need
export { app, analytics, functions };