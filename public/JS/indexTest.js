
//say hello function call
const button = document.querySelector(".call");
button.addEventListener("click", () => {
    const sayHello = firebase.functions().httpsCallable("sayHello");
    sayHello().then(result => {
        console.log(result.data);
    });
});


