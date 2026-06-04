function createFaultyGenerator(baseGenerator) {
  return {
    generate() {
      let msg = baseGenerator.generate();

     
      if (Math.random() < 0.3) {
        const type = Math.floor(Math.random() * 5);

        switch (type) {

      
          case 0:
            if (msg.data) {
              msg.data.temp = "not-a-number";
              console.log(" Injected WRONG TYPE");
            }
            break;

        
          case 1:
            if (msg.data) {
              msg.data.hum = 999;
              console.log(" Injected OUT OF RANGE");
            }
            break;

       
          case 2:
            if (msg.data) {
              delete msg.data.press;
              console.log(" Injected MISSING FIELD");
            }
            break;

  
          case 3:
            if (msg.data) {
              msg.data.fakeValue = 123;
              console.log(" Injected EXTRA FIELD");
            }
            break;

         
          case 4:
            msg.status = null;
            console.log(" Injected BROKEN STRUCTURE");
            break;
        }
      }

      return msg;
    }
  };
}

module.exports = { createFaultyGenerator };
``