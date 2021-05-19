const fs = require("fs");
const express = require("express");
const app = express();
const puppeteer = require("puppeteer-extra");
const pluginStealth = require("puppeteer-extra-plugin-stealth");
const AdblockerPlugin = require("puppeteer-extra-plugin-adblocker");
const reCaptcha = require("./captchaSolver.js");
const RecaptchaPlugin = require("puppeteer-extra-plugin-recaptcha");
const ghostCursor = require("ghost-cursor");
const adblocker = AdblockerPlugin({
  blockTrackers: false,
});
const expressSession = require("express-session")({
  secret: "chegg-secret-key", // Cookie secret key
  resave: false,
  saveUninitialized: false,
});

// Read access ID, requests and expiration data from json file
let rawdata = fs.readFileSync("access.json");
let users = JSON.parse(rawdata);
let witKey = fs.readFileSync("witKey", "utf8");
let recaptchaKey = fs.readFileSync("recaptchaKey", "utf8");

app.set("view-engine", "ejs");
app.use(express.static("views"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(expressSession);

puppeteer.use(pluginStealth()); // For stealth mode against captcha
puppeteer.use(adblocker); // Adblock
puppeteer.use(
  // Backup captcha solver
  RecaptchaPlugin({
    provider: {
      id: "2captcha",
      token: recaptchaKey,
    },
  })
);

app.get("/", (req, res) => {
  if (req.session.accessid === undefined) {
    // If not logged in, go to login screen
    res.redirect("/login");
  } else {
    // Otherwise, go to unlocker screen
    if (!refreshAccessCode(req.session.accessid)) {
      req.session.accessid = undefined;
      req.session.save();
      res.redirect("/login");
    } else {
      res.render("unlocker.ejs", {
        requests: refreshRequestPrint(req.session.accessid),
        expiration: refreshExpirationPrint(req.session.accessid),
        errorMessage: "",
      });
    }
  }
});

app.get("/logout", (req, res) => {
  req.session.accessid = undefined;
  req.session.save();
  res.redirect("/login");
});

app.get("/login", (req, res) => {
  if (req.session.accessid === undefined) {
    // If session not logged in, go to login screen
    res.render("login.ejs", { errorMessage: "" });
  } else {
    if (!refreshAccessCode(req.session.accessid)) {
      // If session logged in, but invalid, go to login screen
      req.session.accessid = undefined;
      req.session.save();
      res.render("login.ejs", { errorMessage: "Session expired" });
    } else {
      res.redirect("/");
    }
  }
});

app.post("/login", (req, res) => {
  if (req.session.accessid === undefined) {
    // Check if cookies are set
    if (!refreshAccessCode(req.body.password)) {
      // Try to login into a session
      console.log("Failed login with password: " + req.body.password);
      res.render("login.ejs", {
        errorMessage: "Invalid access code, try again.",
      });
    } else {
      console.log("Login with password: " + req.body.password);
      req.session.accessid = req.body.password; // Set the cookies
      req.session.save();
      res.redirect("/");
    }
  } else {
    if (!refreshAccessCode(req.session.accessid)) {
      // Check if already logged in into a valid session (cookies)
      req.session.accessid = undefined;
      req.session.save();
      res.render("login.ejs", { errorMessage: "Session expired" });
    } else {
      res.redirect("/");
    }
  }
});

app.post("/unlock", (req, res) => {
  if (req.session.accessid === undefined) {
    // Check if session is valid
    res.redirect("/login");
  } else {
    if (users[req.session.accessid] === undefined) {
      // Check if access code is still valid
      req.session.accessid = undefined;
      console.log("Failed login with password: " + req.body.password);
      res.redirect("/login");
    } else {
      let requestsAmount = refreshRequest(req.session.accessid);
      let expirationDate = refreshExpiration(req.session.accessid);

      if (requestsAmount == 0) {
        // If out of requests
        res.render("login.ejs", { errorMessage: "Out of requests" });
      } else if (
        expirationDate < Math.floor(new Date().getTime() / 1000) &&
        expirationDate > 0
      ) {
        // If past expiration date
        res.render("login.ejs", { errorMessage: "Access expired" });
      } else {
        if (requestsAmount > 0) {
          // Only subtract requests amount if not using expiration date
          users[req.session.accessid]["requests"] -= 1;
          fs.writeFileSync("access.json", JSON.stringify(users));
        }

        req.session.status = "Started unlocking...";
        req.session.save();

        (async () => {
          try {
            const browser = await puppeteer.launch({
              headless: true,
              slowMo: 0,
              args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-web-security",
                "--disable-dev-shm-usage",
              ],
            });

            const page = await browser.newPage();

            await page.setViewport({ width: 1280, height: 800 });
            await page.setUserAgent(
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4427.0 Safari/537.36"
            );
            await page.setExtraHTTPHeaders({
              Origin: "https://www.chegg.com",
            });

            const cursor = ghostCursor.createCursor(
              page,
              await ghostCursor.getRandomPagePoint(page),
              true
            );

            const cookiesString = fs.readFileSync("cookies.json");
            const cookies = JSON.parse(cookiesString);
            await page.setCookie(...cookies);

            if (req.body.chegg_url != "") {
              // If using the URL field (priority)
              try {
                await page.goto(req.body.chegg_url, {
                  waitUntil: "networkidle2",
                  timeout: 8000,
                });
              } catch (e) {}
            } else if (req.body.chegg_keyword != "") {
              // If using the keyword field
              try {
                await page.goto(
                  "https://www.chegg.com/search/" + req.body.chegg_keyword,
                  { waitUntil: "networkidle2", timeout: 5000 }
                );
              } catch (e) {}
            } else {
              await browser.close();
              res.render("unlocker.ejs", {
                requests: refreshRequestPrint(req.session.accessid),
                expiration: refreshExpirationPrint(req.session.accessid),
                errorMessage: "Empty fields",
              });
              return;
            }

            if ((await page.$("#px-captcha")) != null) {
              // Detect captcha screen
              console.log("Captcha detected");
              req.session.status = "Attempting to solve captcha...";
              req.session.save();
              try {
                await reCaptcha(page, cursor, witKey); // Attempting to solve captcha using text to speech recognition
                await page.waitForNavigation({
                  waitUntil: "networkidle2",
                  timeout: 8000,
                });
              } catch (e) {
                console.log("Backup captcha solving");
                req.session.status =
                  "Still solving captcha, this is taking longer than expected...";
                req.session.save();

                // Attempting to solve captcha using 2captcha
                try {
                  await page.solveRecaptchas();
                  req.session.status = "Captcha successfully solved!";
                  req.session.save();
                  await page.waitForNavigation({
                    waitUntil: "networkidle2",
                    timeout: 6000,
                  });
                } catch (e) {}
              }
              console.log("Captcha done");
            }

            if ((await page.$("[data-area*='result1']")) != null) {
              // If arrived in a search screen
              req.session.status = "Found a matching question...";
              req.session.save();
              await cursor.click("[data-area*='result1']");
              try {
                await page.waitForNavigation({
                  waitUntil: "networkidle2",
                  timeout: 5000,
                });
              } catch (e) {
                req.session.status = "Loading taking longer than expected...";
                req.session.save();
                try {
                  await cursor.click("[data-area*='result1']");
                  await page.waitForNavigation({
                    waitUntil: "networkidle2",
                    timeout: 5000,
                  });
                } catch (e) {}
              }
            } else if (
              (await page.$(".answer")) != null ||
              (await page.$(".solution")) != null
            ) {
              // If arrived in a question/textbook screen
              // Found question
              req.session.status = "Found the matching question...";
              req.session.save();
            } else {
              // If invalid url, give them back their request
              console.log("Invalid url: " + req.body.chegg_url);
              if (refreshRequest(req.session.accessid) >= 0) {
                // Only add requests amount if not using expiration date
                users[req.session.accessid]["requests"] += 1;
                fs.writeFileSync("access.json", JSON.stringify(users));
              }

              await browser.close();
              res.render("unlocker.ejs", {
                requests: refreshRequestPrint(req.session.accessid),
                expiration: refreshExpirationPrint(req.session.accessid),
                errorMessage: "No matching question found",
              });
              return null;
            }

            req.session.status = "Screenshotting page...";
            req.session.save();
            const screenshot = await page.screenshot({
              encoding: "base64",
              fullPage: true,
            }); // Screenshot and display
            res.render("imageView.ejs", {
              screenshot: screenshot,
              requests: refreshRequestPrint(req.session.accessid),
              expiration: refreshExpirationPrint(req.session.accessid),
            });
            await browser.close();
            screenshot = "";
            req.session.status = "";
            req.session.save();
          } catch (e) {
            // If error occured, give them back their request and display error message

            if (refreshRequest(req.session.accessid) >= 0) {
              // Only add requests amount if not using expiration date
              users[req.session.accessid]["requests"] += 1;
              fs.writeFileSync("access.json", JSON.stringify(users));
            }

            res.render("unlocker.ejs", {
              requests: refreshRequestPrint(req.session.accessid),
              expiration: refreshExpirationPrint(req.session.accessid),
              errorMessage: "An error occured, please try again",
            });
            console.error("Question scrapping failed");
            console.log(e);
            return null;
          }
        })();
      }
    }
  }
});

app.get("/status", function (req, res) {
  res.send(req.session.status);
});

function refreshAccessCode(accessId) {
  // Function to check if access code is valid
  rawdata = fs.readFileSync("access.json");
  users = JSON.parse(rawdata);

  if (users[accessId] === undefined) {
    return false;
  } else {
    return true;
  }
}

function refreshRequest(accessId) {
  // Function to return the amount of requests left
  rawdata = fs.readFileSync("access.json");
  users = JSON.parse(rawdata);

  return users[accessId]["requests"];
}

function refreshRequestPrint(accessId) {
  // Function to return the amount of requests left for display
  rawdata = fs.readFileSync("access.json");
  users = JSON.parse(rawdata);

  return users[accessId]["requests"] < 0
    ? "No limit"
    : users[accessId]["requests"] + " left";
}

function refreshExpiration(accessId) {
  // Function to return the expiration date
  rawdata = fs.readFileSync("access.json");
  users = JSON.parse(rawdata);

  return users[accessId]["expiration"];
}

function refreshExpirationPrint(accessId) {
  // Function to return the expiration date for display
  rawdata = fs.readFileSync("access.json");
  users = JSON.parse(rawdata);

  date = new Date(users[accessId]["expiration"] * 1000);
  time = date
    .toLocaleTimeString()
    .replace(/([\d]+:[\d]{2})(:[\d]{2})(.*)/, "$1$3");
  day = date.getDate();
  months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  month = months[date.getMonth()];
  year = date.getFullYear();

  return users[accessId]["expiration"] < 0
    ? "No expiration"
    : day + " " + month + " " + year + " @" + time;
}

app.listen(8080);
