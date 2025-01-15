const express = require("express");
const bodyParser = require("body-parser");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const cors = require("cors");
const multer = require("multer"); // For file uploads
const csvParser = require("csv-parser"); // For parsing CSV files

const app = express();
const PORT = 3001;
app.use(cors());

let qrCodeData = null;
let isConnected = false; // Track connection status
let connectedTime = null; // Track the time the device connected

app.use(bodyParser.json({ limit: "50mb" })); // Adjust '50mb' as needed
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

let client = createClient(); // Initialize the WhatsApp client

// Function to create a new WhatsApp client
function createClient() {
  const authPath = path.join(__dirname, ".wwebjs_auth");

  // Clean up auth directory
  if (fs.existsSync(authPath)) {
    fs.rmSync(authPath, { recursive: true, force: true }); // Delete the directory
    console.log("Auth directory cleaned up.");
  }

  const newClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox"],
      timeout: 60000,
    },
  });

  newClient.on("qr", (qr) => {
    qrCodeData = qr;
    isConnected = false;
    connectedTime = null;
    console.log("QR code updated:", qr);
  });

  newClient.on("ready", () => {
    isConnected = true;
    connectedTime = new Date();
    console.log("WhatsApp client is ready!");
    startDisconnectTimer();
  });

  newClient.on("disconnected", () => {
    console.log("WhatsApp client disconnected.");
  });

  newClient.initialize();
  return newClient;
}

// Function to check elapsed time and disconnect if > 30 seconds
const startDisconnectTimer = () => {
  const interval = setInterval(async () => {
    if (connectedTime && isConnected) {
      const currentTime = new Date();
      const elapsedTime = Math.floor((currentTime - connectedTime) / 1000); // Elapsed time in seconds
      if (elapsedTime >= 300) {
        console.log("Disconnecting WhatsApp client...");
        try {
          await client.destroy(); // Destroy the client to release resources
          console.log("Client destroyed. Reinitializing for a new QR code...");
          client = createClient(); // Reinitialize the client
        } catch (error) {
          console.error("Error during disconnect:", error.message);
        } finally {
          isConnected = false;
          connectedTime = null;
          qrCodeData = null;
          clearInterval(interval); // Stop the timer
        }
      }
    }
  }, 1000); // Check every second
};

// API endpoint to retrieve the QR code
app.get("/api/qrcode", (req, res) => {
  if (qrCodeData) {
    res.json({ qrCode: qrCodeData });
  } else {
    res.status(404).json({ message: "QR code not available yet" });
  }
});

// API endpoint to check connection status
app.get("/api/status", (req, res) => {
  res.json({ connected: isConnected });
});

// API endpoint to check connected time
app.get("/api/counter", (req, res) => {
  if (isConnected && connectedTime) {
    const currentTime = new Date();
    const elapsedTime = Math.floor((currentTime - connectedTime) / 1000); // Elapsed time in seconds
    res.json({ connected: true, elapsedTime });
  } else {
    res.json({ connected: false, elapsedTime: 0 });
  }
});

// Multer setup for handling file uploads
const upload = multer({
  dest: "uploads/", // Directory to save uploaded files
  limits: { fileSize: 5 * 1024 * 1024 }, // Limit to 5MB
});

app.post("/api/bulkMessage", upload.single("file"), async (req, res) => {
  try {
    const { message } = req.body;
    const file = req.file; // CSV file

    let image = null;
    if (req.body.image) {
      image = JSON.parse(req.body.image);
    }

    if (!file || (!message && !image)) {
      return res
        .status(400)
        .json({ error: "CSV file and either message or image are required" });
    }

    // Process the uploaded CSV file
    const filePath = path.join(__dirname, file.path);
    console.log("CSV File saved at:", filePath);
    console.log("img:", image);

    // Array to hold all numbers from the CSV
    const numbersArray = ["971461925@c.us"];

    // Read and parse the CSV file
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        console.log(row); // Log each row to check its structure
        if (row.phoneNumber) {
          const phoneNumber = parseInt(row.phoneNumber); // Parse as integer
          console.log("Parsed phone number:", phoneNumber.phoneNumber);
          numbersArray.push(phoneNumber.phoneNumber); // Add to array
        }
      })
      .on("end", () => {
        console.log("CSV file successfully processed.");
        console.log("Extracted numbers:", numbersArray);
      });

    // Save the uploaded image (if provided)
    let imagePath = null;
    if (image && image.data && image.mimetype) {
      const buffer = Buffer.from(image.data, "base64"); // Decode Base64 image

      // Extract the file extension from the mimetype
      const mimeType = image.mimetype; // e.g., "image/png"
      const extension = mimeType.split("/")[1]; // Extract "png"
      const imageName = `image_${Date.now()}.${extension}`;
      imagePath = path.join(__dirname, "uploads", imageName);

      // Write image to the uploads folder
      fs.writeFileSync(imagePath, buffer);
      console.log("Image saved at:", imagePath);
    }

    res.json({
      message: "Bulk messages sent successfully!",
      imagePath: imagePath ? `/uploads/${path.basename(imagePath)}` : null,
    });
  } catch (err) {
    console.error("Error processing bulk message:", err);
    res
      .status(500)
      .json({ error: "An error occurred while processing your request" });
  }
});

// API endpoint for single message
app.post("/api/sendSingleMsg", express.json(), async (req, res) => {
  const { phoneNumber, message, image } = req.body;

  if (!phoneNumber || (!message && !image)) {
    return res
      .status(400)
      .json({ error: "Phone number and either message or image are required" });
  }

  try {
    if (isConnected) {
      const formattedNumber = `${phoneNumber}@c.us`; // Ensure correct phone number format

      // If an image is provided, send it along with the message
      if (image) {
        const media = new MessageMedia(
          image.mimetype,
          image.data,
          image.filename
        );
        await client.sendMessage(formattedNumber, media, { caption: message });
      } else {
        await client.sendMessage(formattedNumber, message);
      }

      res.json({ success: true, message: "Message sent successfully!" });
    } else {
      res.status(503).json({ error: "WhatsApp client is not connected" });
    }
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ error: "Failed to send message or image" });
  }
});



// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
