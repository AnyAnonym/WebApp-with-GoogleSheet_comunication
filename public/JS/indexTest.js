// indexTest.js
import { functions } from "./SDK.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-functions.js";

document.querySelector(".call").addEventListener("click", async () => {
  const sayHello = httpsCallable(functions, "sayHello");
  const result = await sayHello();
  console.log(result.data);
});

document.querySelector(".call2").addEventListener("click", async () => {
  const testFn = httpsCallable(functions, "testFunctionJunction");
  const result = await testFn();
  console.log(result.data);
});

