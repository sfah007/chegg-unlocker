const fs = require("fs");
const express = require("express");
const app = express();
const puppeteer = require("puppeteer-extra");
const pluginStealth = require("puppeteer-extra-plugin-stealth");
const AdblockerPlugin = require("puppeteer-extra-plugin-adblocker");
const reCaptcha = require("./captchaSolver.js");
const { Cluster } = require("puppeteer-cluster");
const RecaptchaPlugin = require("puppeteer-extra-plugin-recaptcha");
const ghostCursor = require("ghost-cursor");
const adblocker = AdblockerPlugin({
  blockTrackers: true,
});
const expressSession = require("express-session")({
  secret: "chegg-secret-key", // Cookie secret key
  resave: false,
  saveUninitialized: false,
});

app.set("view-engine", "ejs");
app.use(express.static("views"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(expressSession);

// Read access ID, requests and expiration data from json file
let rawdata = fs.readFileSync("access.json");
let users = JSON.parse(rawdata);
let apikeys = JSON.parse(fs.readFileSync("apikeys.json"));
let firstTime = true;

puppeteer.use(pluginStealth()); // For stealth mode against captcha
puppeteer.use(adblocker); // Adblock
puppeteer.use(
  // Backup captcha solver
  RecaptchaPlugin({
    provider: {
      id: "2captcha",
      token: apikeys.recaptcha,
    },
  })
);

(async () => {
  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_PAGE,
    maxConcurrency: 1,
    timeout: 100000,
    monitor: true,
    puppeteer,
    puppeteerOptions: {
      headless: true,
      slowMo: 0,
      userDataDir: "./cache/",
      ignoreHTTPSErrors: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-web-security",
        "--disable-dev-shm-usage",
        "--disable-features=site-per-process",
        "--proxy-server=" + apikeys.proxyip, // Dedicated proxy server to bypass most if not all captcha
      ],
    },
  });

  let usersOnline = [];

  await cluster.task(async ({ page, data }) => {
    const { url, req, res, usingURL } = data;

    try {
      res.render("imageView.ejs", {
        screenshot: fs.readFileSync("database/" + searchDatabase(url.replace(/\?/g, "")), { encoding: "base64" }),
        requests: refreshRequestPrint(req.session.accessid),
        expiration: refreshExpirationPrint(req.session.accessid),
        refresh: true,
        url: url,
      });

      setStatus(req, "");
      removeUserOnline(req.session.accessid);
      return;
    } catch (e) {
      try {
        setStatus(req, "Started unlocking...");

        if (firstTime) {
          console.log("Logging in proxy");
          await page.authenticate({
            username: apikeys.proxyusername,
            password: apikeys.proxypassword,
          });
          firstTime = false;
        }

        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4427.0 Safari/537.36");
        await page.setExtraHTTPHeaders({
          Origin: "https://www.chegg.com",
        });

        const cursor = ghostCursor.createCursor(page, await ghostCursor.getRandomPagePoint(page));

        const cookiesString = fs.readFileSync("cookies.json");
        const cookies = JSON.parse(cookiesString);
        await page.setCookie(...cookies);

        if (usingURL) {
          // If using the URL field (priority)
          try {
            await page.goto(url, {
              waitUntil: "load",
              timeout: 8000,
            });
          } catch (e) {}
        } else if (!usingURL) {
          // If using the keyword field
          try {
            await page.goto("https://www.chegg.com/search/" + url, {
              waitUntil: "networkidle2",
              timeout: 8000,
            });
          } catch (e) {}
        } else {
          res.render("unlocker.ejs", {
            requests: refreshRequestPrint(req.session.accessid),
            expiration: refreshExpirationPrint(req.session.accessid),
            errorMessage: "Empty fields",
          });

          setStatus(req, "");
          removeUserOnline(req.session.accessid);
          return;
        }

        if ((await page.$("#px-captcha")) != null) {
          // Detect captcha screen and solve captch (if no proxy server provided)
          console.log("Captcha detected");
          setStatus(req, "Attempting to solve captcha...");

          try {
            await page.waitForNavigation({
              waitUntil: "networkidle2",
              timeout: 5000,
            });
          } catch (e) {}

          try {
            await reCaptcha(page, cursor, apikeys.witai); // Attempting to solve captcha using text to speech recognition
            await page.waitForNavigation({
              waitUntil: "load",
              timeout: 10000,
            });
          } catch (e) {
            console.log(e);
            console.log("Backup captcha solving");
            setStatus(req, "Still solving captcha, this is taking longer than expected...");

            // Attempting to solve captcha using 2captcha
            try {
              await page.solveRecaptchas();
              setStatus(req, "Captcha successfully solved!");
              await page.waitForNavigation({
                waitUntil: "load",
                timeout: 8000,
              });
            } catch (e) {}
          }
          console.log("Captcha done");
        }

        if ((await page.$("[data-area*='result1']")) != null) {
          // If arrived in a search screen
          setStatus(req, "Found a matching solution...");

          await cursor.click("[data-area*='result1']");

          try {
            await page.waitForNavigation({
              waitUntil: "networkidle2",
              timeout: 8000,
            });
          } catch (e) {}

          try {
            setStatus(req, "Loading the matching question...");
            if ((await page.$(".dialog-question")) != null) {
              await page.evaluate(async () => {
                const div = document.querySelector(".dialog-question");
                const images = Array.from(div.querySelectorAll("img"));
                await Promise.all(
                  images.map((img) => {
                    if (img.complete) return;
                    return new Promise((resolve, reject) => {
                      img.addEventListener("load", resolve);
                      img.addEventListener("error", reject);
                    });
                  })
                );
              });
            } else {
              setStatus(req, "Loading the matching solution...");
              try {
                await page.waitForNavigation({
                  waitUntil: "networkidle2",
                  timeout: 10000,
                });
              } catch (e) {}
            }
          } catch (e) {}
        } else if ((await page.$(".dialog-question")) != null) {
          // If arrived in a question/textbook screen
          setStatus(req, "Loading the matching question...");
          try {
            // Wait for all the pictures to load before screenshotting
            await page.evaluate(async () => {
              const div = document.querySelector(".dialog-question");
              const images = Array.from(div.querySelectorAll("img"));
              await Promise.all(
                images.map((img) => {
                  if (img.complete) return;
                  return new Promise((resolve, reject) => {
                    img.addEventListener("load", resolve);
                    img.addEventListener("error", reject);
                  });
                })
              );
            });
          } catch (e) {}
        } else if ((await page.$(".right-rail-adjust")) != null) {
          // If arrived in a question/textbook screen
          setStatus(req, "Loading the matching solution...");
          try {
            // Wait for all the pictures to load before screenshotting
            await page.waitForNavigation({
              waitUntil: "networkidle2",
              timeout: 10000,
            });
          } catch (e) {}
        } else {
          // If invalid url, give them back their request
          console.log("Invalid url: " + url);
          if (refreshRequest(req.session.accessid) >= 0) {
            // Only add requests amount if not using expiration date
            users[req.session.accessid]["requests"] += 1;
            fs.writeFileSync("access.json", JSON.stringify(users));
          }

          res.render("unlocker.ejs", {
            requests: refreshRequestPrint(req.session.accessid),
            expiration: refreshExpirationPrint(req.session.accessid),
            errorMessage: "No matching question found",
          });

          setStatus(req, "");
          removeUserOnline(req.session.accessid);
          return;
        }

        setStatus(req, "Screenshotting page...");

        const answer = (await page.$(".dialog-question")) ?? (await page.$(".right-rail-adjust"));
        const bounding_box = await answer.boundingBox();
        screenshot = await page.screenshot({
          type: "jpeg",
          encoding: "base64",
          clip: {
            x: bounding_box.x,
            y: bounding_box.y - 5,
            width: bounding_box.width,
            height: bounding_box.height + 5,
          },
        });

        // Screenshot and display

        res.render("imageView.ejs", {
          screenshot: screenshot,
          requests: refreshRequestPrint(req.session.accessid),
          expiration: refreshExpirationPrint(req.session.accessid),
          refresh: false,
          url: url,
        });

        addToDatabase(screenshot, page.url().split("?")[0], url);

        setStatus(req, "");
        removeUserOnline(req.session.accessid);
        return;
      } catch (e) {
        console.log(e);

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

        setStatus(req, "");
        removeUserOnline(req.session.accessid);
        return;
      }
    }
  });

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
    setStatus(req, "");
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
        setStatus(req, "");
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

  app.post("/unlock", async (req, res) => {
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
        let skipDatabase = req.body.skipDatabase ?? false;

        if (requestsAmount == 0) {
          // If out of requests
          res.render("login.ejs", { errorMessage: "Out of requests" });
        } else if (expirationDate < Math.floor(new Date().getTime() / 1000) && expirationDate > 0) {
          // If past expiration date
          res.render("login.ejs", { errorMessage: "Access expired" });
        } else {
          if (requestsAmount > 0) {
            // Only subtract requests amount if not using expiration date
            users[req.session.accessid]["requests"] -= 1;
            fs.writeFileSync("access.json", JSON.stringify(users));
          }

          try {
            if (isUserOffline(req.session.accessid)) {
              addUserOnline(req.session.accessid);
              setStatus(req, "Server overload, waiting in the queue...");
              if (req.body.chegg_url.match(/(^$|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/)) {
                // If using a URL
                const filename = searchDatabase(req.body.chegg_url);
                if (filename == null || skipDatabase) {
                  await cluster.execute({ url: req.body.chegg_url, req: req, res: res, usingURL: true });
                } else {
                  try {
                    res.render("imageView.ejs", {
                      screenshot: fs.readFileSync("database/" + filename, { encoding: "base64" }),
                      requests: refreshRequestPrint(req.session.accessid),
                      expiration: refreshExpirationPrint(req.session.accessid),
                      refresh: true,
                      url: req.body.chegg_url,
                    });
                  } catch (e) {
                    await cluster.execute({ url: req.body.chegg_url, req: req, res: res, usingURL: true });
                  }
                }
                removeUserOnline(req.session.accessid);
              } else if (req.body.chegg_url.match(/\w+/g)) {
                // If using keywords
                const filename = searchDatabase(req.body.chegg_url.replace(/\?/g, ""));
                if (filename == null || skipDatabase) {
                  await cluster.execute({ url: req.body.chegg_url.replace(/\?/g, ""), req: req, res: res, usingURL: false });
                } else {
                  try {
                    res.render("imageView.ejs", {
                      screenshot: fs.readFileSync("database/" + filename, { encoding: "base64" }),
                      requests: refreshRequestPrint(req.session.accessid),
                      expiration: refreshExpirationPrint(req.session.accessid),
                      refresh: true,
                      url: req.body.chegg_url,
                    });
                  } catch (e) {
                    await cluster.execute({ url: req.body.chegg_url.replace(/\?/g, ""), req: req, res: res, usingURL: false });
                  }
                }
                removeUserOnline(req.session.accessid);
              } else {
                if (refreshRequest(req.session.accessid) >= 0) {
                  // Only add requests amount if not using expiration date
                  users[req.session.accessid]["requests"] += 1;
                  fs.writeFileSync("access.json", JSON.stringify(users));
                }
                res.render("unlocker.ejs", {
                  requests: refreshRequestPrint(req.session.accessid),
                  expiration: refreshExpirationPrint(req.session.accessid),
                  errorMessage: "Empty fields",
                });
                setStatus(req, "");
                removeUserOnline(req.session.accessid);
              }
            } else {
              if (refreshRequest(req.session.accessid) >= 0) {
                // Only add requests amount if not using expiration date
                users[req.session.accessid]["requests"] += 1;
                fs.writeFileSync("access.json", JSON.stringify(users));
              }

              if (req.session.status == "") {
                setStatus(req, "");
                req.session.accessid = undefined;
                req.session.save();
                res.render("login.ejs", {
                  errorMessage: "Only 1 user per account allowed.",
                });
              } else {
                res.render("unlocker.ejs", {
                  requests: refreshRequestPrint(req.session.accessid),
                  expiration: refreshExpirationPrint(req.session.accessid),
                  errorMessage: "You already have another unlock running, wait for the first one to finish!",
                });
              }
            }
          } catch (e) {
            console.log(e);

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

            setStatus(req, "");
            removeUserOnline(req.session.accessid);
          }
        }
      }
    }
  });

  app.get("/status", function (req, res) {
    let queue = 0;

    if (!isUserOffline(req.session.accessid)) {
      const index = usersOnline.indexOf(req.session.accessid);
      if (index > -1) {
        queue = index;
      } else {
        queue = 0;
      }
    } else {
      queue = usersOnline.length;
    }

    res.json({ message: req.session.status, queue: queue });
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

    return users[accessId]["requests"] < 0 ? "No limit" : users[accessId]["requests"] + " left";
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
    time = date.toLocaleTimeString().replace(/([\d]+:[\d]{2})(:[\d]{2})(.*)/, "$1$3");
    day = date.getDate();
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    month = months[date.getMonth()];
    year = date.getFullYear();

    return users[accessId]["expiration"] < 0 ? "No expiration" : day + " " + month + " " + year + " @" + time;
  }

  function setStatus(req, message) {
    req.session.status = message;
    req.session.save();
  }

  function isUserOffline(accessId) {
    try {
      if (accessId != undefined && users[accessId] != undefined && usersOnline.includes(accessId) == false) {
        return true;
      } else {
        return false;
      }
    } catch (e) {
      return false;
    }
  }

  function addUserOnline(accessId) {
    usersOnline.push(accessId);
  }

  function removeUserOnline(accessId) {
    const index = usersOnline.indexOf(accessId);
    if (index > -1) {
      usersOnline.splice(index, 1);
    }
  }

  const fillerWords = JSON.parse(fs.readFileSync("filler.json"));
  let dbSize = Object.keys(JSON.parse(fs.readFileSync("database.json"))).length;

  function addToDatabase(screenshot, currenturl, searchkeywords) {
    try {
      database = fs.readFileSync("database.json");
      let data = JSON.parse(database);

      if (searchDatabase(currenturl) == null && searchDatabase(searchkeywords) == null) {
        // If screenshot not in database, add it to database
        data[searchkeywords] = dbSize + ".jpeg";
        fs.writeFileSync("database.json", JSON.stringify(data));
        fs.writeFileSync("database/" + dbSize++ + ".jpeg", screenshot, "base64", function (e) {
          console.log(e);
        });
      } else {
        // Search database and add pointer to that screenshot
        let filename = searchDatabase(searchkeywords) ?? searchDatabase(currenturl);
        data[searchkeywords] = filename;
        fs.writeFileSync("database.json", JSON.stringify(data));
        fs.writeFileSync("database/" + filename, screenshot, "base64", function (e) {
          console.log(e);
        });
      }
    } catch (e) {
      console.log(e);
    }
  }

  function searchDatabase(keywords) {
    try {
      const database = fs.readFileSync("database.json");
      let data = JSON.parse(database);
      let searchKeywords, dbKeywords;

      try {
        if (keywords.match(/(^$|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/)) {
          searchKeywords = keywords
            .split("/")[5]
            .split("q")[0]
            .toLowerCase()
            .replace(/[/’/ $-/:-?{-~!"^_`\[\]]/g, "");
        } else {
          searchKeywords = keywords
            .toLowerCase()
            .replace(/[/’$-/:-?{-~!"^_`\[\]]/g, "")
            .replace(new RegExp(fillerWords.join("\\b|\\b"), "g"), "")
            .replace(/\ /g, "");
        }
      } catch (e) {}

      for (i in Object.keys(data)) {
        try {
          if (Object.keys(data)[i].match(/(^$|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/)) {
            dbKeywords = Object.keys(data)
              [i].split("/")[5]
              .split("q")[0]
              .toLowerCase()
              .replace(/[/’/ $-/:-?{-~!"^_`\[\]]/g, "");
          } else {
            dbKeywords = Object.keys(data)
              [i].toLowerCase()
              .replace(/[/’$-/:-?{-~!"^_`\[\]]/g, "")
              .replace(new RegExp(fillerWords.join("\\b|\\b"), "g"), "")
              .replace(/\ /g, "");
          }
        } catch (e) {}

        if (dbKeywords.includes(searchKeywords) || searchKeywords.includes(dbKeywords)) {
          return Object.values(data)[i];
        }
      }
    } catch (e) {
      console.log(e);
      return null;
    }
    return null;
  }

  app.listen(8080);
})();
