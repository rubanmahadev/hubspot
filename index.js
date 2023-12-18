require("dotenv").config();
const express = require("express");
const request = require("request-promise-native");
const NodeCache = require("node-cache");
const session = require("express-session");
const opn = require("open");
const hubspot = require("@hubspot/api-client");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

let hubspotClient;

const PORT = 3000;

const refreshTokenStore = {};
const accessTokenCache = new NodeCache({ deleteOnExpire: true });

if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET) {
  throw new Error("Missing CLIENT_ID or CLIENT_SECRET environment variable.");
}

//===========================================================================//
//  HUBSPOT APP CONFIGURATION
//
//  All the following values must match configuration settings in your app.
//  They will be used to build the OAuth URL, which users visit to begin
//  installing. If they don't match your app's configuration, users will
//  see an error page.

// Replace the following with the values from your app auth config,
// or set them as environment variables before running.
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// Scopes for this app will default to `crm.objects.contacts.read`
// To request others, set the SCOPE environment variable instead
let SCOPES = ["crm.objects.contacts.read"];
if (process.env.SCOPE) {
  SCOPES = process.env.SCOPE.split(/ |, ?|%20/).join(" ");
}

// On successful install, users will be redirected to /oauth-callback
const REDIRECT_URI = `http://localhost:${PORT}/oauth-callback`;

//===========================================================================//

// Use a session to keep track of client ID
app.use(
  session({
    secret: Math.random().toString(36).substring(2),
    resave: false,
    saveUninitialized: true,
  })
);

//================================//
//   Running the OAuth 2.0 Flow   //
//================================//

// Step 1
// Build the authorization URL to redirect a user
// to when they choose to install the app
const authUrl =
  "https://app.hubspot.com/oauth/authorize" +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` + // app's client ID
  `&scope=${encodeURIComponent(SCOPES)}` + // scopes being requested by the app
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`; // where to send the user after the consent page

// Redirect the user from the installation page to
// the authorization URL
app.get("/install", (req, res) => {
  console.log("");
  console.log("=== Initiating OAuth 2.0 flow with HubSpot ===");
  console.log("");
  console.log("===> Step 1: Redirecting user to your app's OAuth URL");
  res.redirect(authUrl);
  console.log("===> Step 2: User is being prompted for consent by HubSpot");
});

// Step 2
// The user is prompted to give the app access to the requested
// resources. This is all done by HubSpot, so no work is necessary
// on the app's end

// Step 3
// Receive the authorization code from the OAuth 2.0 Server,
// and process it based on the query parameters that are passed

app.get("/oauth-callback", async (req, res) => {
  console.log("===> Step 3: Handling the request sent by the server");

  // Received a user authorization code, so now combine that with the other
  // required values and exchange both for an access token and a refresh token
  if (req.query.code) {
    console.log("       > Received an authorization token");

    const authCodeProof = {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code: req.query.code,
    };

    // Step 4
    // Exchange the authorization code for an access token and refresh token
    console.log(
      "===> Step 4: Exchanging authorization code for an access token and refresh token"
    );
    const token = await exchangeForTokens(req.sessionID, authCodeProof);
    if (token.message) {
      return res.redirect(`/error?msg=${token.message}`);
    }

    hubspotClient = new hubspot.Client({ accessToken: token.access_token });

    //redirect to localhost 4200 (frontend)
    return res.redirect(`http://localhost:4200?session_id=${req.sessionID}`);
  }
});

//==========================================//
//   Exchanging Proof for an Access Token   //
//==========================================//

const exchangeForTokens = async (userId, exchangeProof) => {
  try {
    const responseBody = await request.post(
      "https://api.hubapi.com/oauth/v1/token",
      {
        form: exchangeProof,
      }
    );
    // Usually, this token data should be persisted in a database and associated with
    // a user identity.
    const tokens = JSON.parse(responseBody);
    refreshTokenStore[userId] = tokens.refresh_token;
    accessTokenCache.set(
      userId,
      tokens.access_token,
      Math.round(tokens.expires_in * 0.75)
    );

    console.log("       > Received an access token and refresh token");
    return tokens.access_token;
  } catch (e) {
    console.error(
      `       > Error exchanging ${exchangeProof.grant_type} for access token`
    );
    return JSON.parse(e.response.body);
  }
};

const refreshAccessToken = async (userId) => {
  const refreshTokenProof = {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    refresh_token: refreshTokenStore[userId],
  };
  return await exchangeForTokens(userId, refreshTokenProof);
};

const getAccessToken = async (userId) => {
  // If the access token has expired, retrieve
  // a new one using the refresh token
  if (!accessTokenCache.get(userId)) {
    console.log("Refreshing expired access token");
    await refreshAccessToken(userId);
  }
  return accessTokenCache.get(userId);
};

const isAuthorized = (userId) => {
  return refreshTokenStore[userId] ? true : false;
};

//========================================//
//   Displaying information to the user   //
//========================================//

const displayContactName = (res, contact) => {
  if (contact.status === "error") {
    res.write(
      `<p>Unable to retrieve contact! Error Message: ${contact.message}</p>`
    );
    return;
  }
  const { firstname, lastname } = contact.properties;
  res.write(`<p>Contact name: ${firstname.value} ${lastname.value}</p>`);
};

app.get("/", async (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.write(`<h2>HubSpot OAuth 2.0 Quickstart App</h2>`);
  res.write(`<a href="/install"><h3>Install the app</h3></a>`);
  res.end();
});

// app.get('/session',async (req,res)=>{


app.get("/contacts.list", async (req, res) => {
  try {
    const session_id = req.query.session_id;
    if (!session_id || !isAuthorized(session_id)) {
      return res.status(401).send({ error: "Unauthorized" });
    }

    // Refresh the token
    let token;
    try {
      token = await getAccessToken(session_id);
      console.log(`token: ${token}`);
    } catch (tokenError) {
      console.error("Error refreshing token:", tokenError);
      return res.status(401).send({ error: "Unauthorized" });
    }

    if (!token) {
      return res.status(401).send({ error: "Unauthorized" });
    }

    let response;
    try {
      response = await hubspotClient.apiRequest({
        path: "/contacts/v1/lists/all/contacts/all?property=phone&property=firstname&property=lastname&property=email&count=100",
        headers: {
          Authorization: "Bearer " + token,
        },
      });
    } catch (apiRequestError) {
      console.error("Error making API request:", apiRequestError);
      return res.status(500).send({ error: "Internal Server Error" });
    }

    let contact;
    try {
      contact = await response.json();
    } catch (jsonError) {
      console.error("Error parsing JSON response:", jsonError);
      return res.status(500).send({ error: "Internal Server Error" });
    }

    const contacts = contact.contacts.map((contact) => ({
      id: contact.vid,
      firstName: contact.properties.firstname
        ? contact.properties.firstname.value
        : "",
      lastName: contact.properties.lastname
        ? contact.properties.lastname.value
        : "",
      email: contact.properties.email ? contact.properties.email.value : "",
      phone: contact.properties.phone ? contact.properties.phone.value : "",
    }));

    return res.send(contacts);
  } catch (error) {
    console.error("Unexpected error:", error);
    return res.status(500).send({ error: "Internal Server Error" });
  }
});


// get ID --> from query param


app.get("/contacts.get", async (req, res) => {
  try {
    let session_id = req.query.session_id;
    let contactId = req.query.id; // Retrieve id from query parameters

    // Check authorization
    if (!isAuthorized(session_id)) {
      return res.status(401).send({ error: "Unauthorized" });
    }

    const token = await getAccessToken(session_id);
    console.log(`token: ${token}`);

    if (!token) {
      return res.status(401).send({ error: "Unauthorized" });
    }

    // Ensure that contactId is provided
    if (!contactId) {
      return res.status(400).send({ error: "Contact ID is required" });
    }

    hubspotClient = new hubspot.Client({ accessToken: token });

    try {
      // Retrieve contact by ID
      const response = await hubspotClient.apiRequest({
        path: `/contacts/v1/contact/vid/${contactId}/profile`,
        headers: {
          Authorization: "Bearer " + token,
        },
      });
      const contact = await response.json();

      if (!contact) {
        return res.status(404).send({ error: "Contact not found" });
      }

      // Send the contact information in the response
      console.log(JSON.stringify(contact));
      const contacts = {
        id: contact.vid,
        firstName: contact.properties.firstname?.value || "",
        lastName: contact.properties.lastname?.value || "",
        email: contact.properties.email?.value || "",
        phone: contact.properties.phone?.value || "",
      };
      res.send(contacts);
    } catch (error) {
      console.error("Error parsing contact JSON:", error);
      res.status(500).send({ error: "Internal Server Error" });
    }
  } catch (error) {
    console.error("Error in contacts.get endpoint:", error);
    res.status(500).send({ error: "Internal Server Error" });
  }
});



app.post("/contacts.create", async (req, res) => {
  try {
    let session_id = req.body.session_id;

    if (!session_id || !isAuthorized(session_id)) {
      return res.status(401).send({ error: "Unauthorized" });
    }

    // Print the JSON body
    const token = await getAccessToken(session_id);
    console.log(`token: ${token}`);

    if (!token) {
      return res.status(401).send({ error: "Unauthorized" });
    }

    hubspotClient = new hubspot.Client({ accessToken: token });

    try {
      const contact = await hubspotClient.crm.contacts.basicApi.create({
        properties: {
          firstname: req.body.firstname,
          lastname: req.body.lastname,
          email: req.body.email,
          phone: req.body.phone,
        },
      });

      res.send(contact);
    } catch (createError) {
      console.error("Error creating contact:", createError);
      res.status(500).send({ error: "Error creating contact" });
    }
  } catch (error) {
    console.error("Error in contacts.create endpoint:", error);
    res.status(500).send({ error: "Internal Server Error" });
  }
});


app.patch("/contacts.update", async (req, res) => {
  try {
    let session_id = req.body.session_id;
    if (!isAuthorized(session_id)) {
      return res.status(401).send({ error: "Unauthorized" });
    }

    // Print the JSON body
    const token = await getAccessToken(session_id);
    console.log(`token: ${token}`);

    if (!token) {
      return res.status(401).send({ error: "Unauthorized" });
    }

    hubspotClient = new hubspot.Client({ accessToken: token });

    try {
      const contact = await hubspotClient.crm.contacts.basicApi.update(
        req.body.id,
        {
          properties: {
            firstname: req.body.firstname,
            lastname: req.body.lastname,
            email: req.body.email,
            phone: req.body.phone,
          },
        }
      );

      res.send(contact);
    } catch (updateError) {
      console.error("Error updating contact:", updateError);
      res.status(500).send({ error: "Error updating contact" });
    }
  } catch (error) {
    console.error("Error in contacts.update endpoint:", error);
    res.status(500).send({ error: "Internal Server Error" });
  }
});


async function deleteContactById(contactId, token) {
  const url = `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`;

  try {
    const response = await axios.delete(url, {
      headers: {
        Authorization: `Bearer  ${token}`,
      },
    });

    return response.data;
  } catch (error) {
    console.error(error);
    return null;
  }
}


app.post('/contacts.delete', async (req, res) => {
  try {
    console.log(req.body);
    
    let contactId = req.body.id
    let session_id = req.body.session_id;

    // Check if the request is authorized
    if(!isAuthorized(session_id)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Get access token
    const token = await getAccessToken(session_id);

    // Check if the access token is valid
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Initialize HubSpot client
    hubspotClient = new hubspot.Client({ accessToken: token });

    // Archive the contact
    const contact = await hubspotClient.crm.contacts.basicApi.archive(contactId);

    // Send success response
    res.json({ success: true, message: 'Contact archived successfully', data: contact });
  } catch (error) {
    console.error('Error:', error);

    // Handle specific errors
    if (error.response && error.response.status) {
      const statusCode = error.response.status;
      if (statusCode === 404) {
        res.status(404).json({ error: 'Contact not found' });
        return;
      }
      // Handle other specific errors as needed
    }

    // Generic error response
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


app.get("/error", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.write(`<h4>Error: ${req.query.msg}</h4>`);
  res.end();
});

app.post("/logout", (req, res) => {
  const session_id = req.body.session_id;
  console.log(session_id);
  console.log(JSON.stringify(req.body));
  if (!session_id || !isAuthorized(session_id)) {
    return res.send({ error: "Unauthorized" }); // return to stop execution
  }

  refreshTokenStore[session_id] = null;
  res.send({ status: "Logged out" }); // send a response to end the request
});

app.listen(PORT, () =>
  console.log(`=== Starting your app on http://localhost:${PORT} ===`)
);

// opn(`http://localhost:${PORT}`);
