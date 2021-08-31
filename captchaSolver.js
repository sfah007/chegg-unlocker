const axios = require("axios");
const https = require("https");

function rdn(min, max) {
  // Function to generate random number based off max and min
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min)) + min;
}

async function reCaptcha(page, cursor, apikey) {
  try {
    // Find the checkbox
    await page.waitForFunction(() => {
      const iframe = document.querySelector('iframe[src*="api2/anchor"]');
      if (!iframe) return false;

      return !!iframe.contentWindow.document.querySelector("#recaptcha-anchor");
    });

    // Click the captcha checkbox
    let frames = await page.frames();
    const recaptchaFrame = frames.find((frame) => frame.url().includes("api2/anchor"));
    const checkbox = await recaptchaFrame.$("#recaptcha-anchor");
    await cursor.click(checkbox, {
      waitForClick: rdn(50, 100),
      waitForSelector: rdn(100, 150),
      paddingPercentage: 2,
    });

    await page.waitForTimeout(rdn(500, 800));

    // Click the audio captcha button
    frames = await page.frames();
    const imageFrame = frames.find((frame) => frame.url().includes("api2/bframe"));
    const audioButton = await imageFrame.$("#recaptcha-audio-button");
    await cursor.click(audioButton, {
      waitForClick: rdn(100, 150),
      waitForSelector: rdn(100, 150),
      paddingPercentage: 0,
    });

    // Loop through until it's solved
    while (true) {
      try {
        await page.waitForFunction(
          () => {
            const iframe = document.querySelector('iframe[src*="api2/bframe"]');
            if (!iframe) return false;

            return !!iframe.contentWindow.document.querySelector(".rc-audiochallenge-tdownload-link");
          },
          { timeout: 1000 }
        );
      } catch (e) {
        // Cannot find audio captcha link, likely flagged as bot
        return null;
      }

      // Get the audio source from the button
      const audioLink = await page.evaluate(() => {
        const iframe = document.querySelector('iframe[src*="api2/bframe"]');
        return iframe.contentWindow.document.querySelector("#audio-source").src;
      });

      // Get audio file from source
      const audioBytes = await page.evaluate((audioLink) => {
        return (async () => {
          const response = await window.fetch(audioLink);
          const buffer = await response.arrayBuffer();
          return Array.from(new Uint8Array(buffer));
        })();
      }, audioLink);

      // Send to wit.ai for speech to text processing
      const httsAgent = new https.Agent({ rejectUnauthorized: false });
      const response = await axios({
        httsAgent,
        method: "post",
        url: "https://api.wit.ai/speech",
        data: new Uint8Array(audioBytes).buffer,
        headers: {
          Authorization: "Bearer " + apikey,
          "Content-Type": "audio/mpeg3",
        },
      });

      // If cannot understand audio, try again
      if (undefined == response.data.text) {
        const reloadButton = await imageFrame.$("#recaptcha-reload-button");
        await cursor.click(reloadButton, {
          waitForClick: rdn(150, 200),
          waitForSelector: rdn(100, 150),
          paddingPercentage: 2,
        });
        continue;
      }

      // Enter text in input and click verify button
      const audioTranscript = response.data.text.trim();
      const input = await imageFrame.$("#audio-response");
      await cursor.click(input, {
        waitForClick: rdn(25, 100),
        waitForSelector: rdn(100, 150),
        paddingPercentage: 2,
      });
      await input.type(audioTranscript, { delay: rdn(50, 75) });

      const verifyButton = await imageFrame.$("#recaptcha-verify-button");
      await cursor.click(verifyButton, {
        waitForClick: rdn(25, 100),
        waitForSelector: rdn(200, 300),
        paddingPercentage: 2,
      });

      try {
        // Check if captcha is solved
        await page.waitForFunction(
          () => {
            const iframe = document.querySelector('iframe[src*="api2/anchor"]');
            if (!iframe) return false;

            return !!iframe.contentWindow.document.querySelector('#recaptcha-anchor[aria-checked="true"]');
          },
          { timeout: 1000 }
        );

        return page.evaluate(() => document.getElementById("g-recaptcha-response").value);
      } catch (e) {
        continue; // Multiple audio, restart loop
      }
    }
  } catch (e) {
    console.error("Captcha failed");
    console.log(e);
    return;
  }
}

module.exports = { reCaptcha, rdn };
