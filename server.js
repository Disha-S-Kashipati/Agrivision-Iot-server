// server.js
require("dotenv").config();
const express = require("express");
const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");

const app = express();

// Parse JSON bodies (increase limit for base64 images)
app.use(express.json({ limit: "15mb" }));

// ---- Config from .env ----
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || "AgriVision_IoT";
const PORT = process.env.PORT || 3000;

// ---- MongoDB client ----
const client = new MongoClient(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// ---- Helper: sanitize collection name (field_id) ----
function sanitizeCollectionName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  // allowed: letters, numbers, underscore, dash — up to 100 chars
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(trimmed)) return null;
  return trimmed;
}

// ---- Helper: decode base64 image to Buffer ----
function decodeBase64Image(dataString) {
  try {
    // Optional: handle "data:image/jpeg;base64,..." or plain base64
    let base64Data = dataString;
    const matches = dataString.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      base64Data = matches[2];
    }
    const buffer = Buffer.from(base64Data, "base64");
    return { buffer };
  } catch (err) {
    console.error("Error decoding base64 image:", err.message);
    return { buffer: null };
  }
}

// ---- Route: receive readings from IoT device ----
app.post("/api/store-reading", async (req, res) => {
  try {
    const {
      field_id,
      soil_moisture,
      temperature,
      humidity,
      image_base64,
      database_name, // optional from device, but we will still use DATABASE_NAME env
    } = req.body;

    // validate field_id -> used as collection name
    const collectionName = sanitizeCollectionName(field_id);
    if (!collectionName) {
      return res.status(400).json({
        error:
          "Invalid field_id. Use only letters, numbers, - and _ (max 100 chars).",
      });
    }

    // validate required sensor values
    if (image_base64 == null) {
      return res.status(400).json({ error: "image_base64 is required" });
    }
    if (
      [soil_moisture, temperature, humidity].some(
        (v) => v === undefined || v === null
      )
    ) {
      return res.status(400).json({
        error: "soil_moisture, temperature and humidity are required",
      });
    }

    const soil = Number(soil_moisture);
    const temp = Number(temperature);
    const hum = Number(humidity);

    if ([soil, temp, hum].some((n) => Number.isNaN(n))) {
      return res
        .status(400)
        .json({ error: "Sensor values must be numeric" });
    }

    // decode image
    const { buffer } = decodeBase64Image(image_base64);

    // optional: save image file locally for debugging
    let savedFilename = null;
    try {
      if (buffer) {
        const uploadsDir = path.join(__dirname, "uploads");
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        const timestamp = Date.now();
        savedFilename = path.join(
          uploadsDir,
          `${collectionName}_${timestamp}.jpg`
        );
        fs.writeFileSync(savedFilename, buffer);
      }
    } catch (e) {
      console.warn("Could not save image locally:", e.message);
    }

    // connect to db & use collection named after field_id
    const db = client.db(DATABASE_NAME);
    const collection = db.collection(collectionName); // each field_id => collection

    const doc = {
      field_id: collectionName,
      soil_moisture: soil,
      temperature: temp,
      humidity: hum,
      image_base64, // store base64 (optional, can remove if only Buffer is needed)
      saved_file: savedFilename,
      created_at: new Date(),
    };

    const result = await collection.insertOne(doc);

    console.log("✅ Inserted reading:", {
      collection: collectionName,
      _id: result.insertedId,
      soil,
      temp,
      hum,
    });

    return res.json({
      success: true,
      insertedId: result.insertedId,
      collection: collectionName,
      saved_file: savedFilename,
    });
  } catch (err) {
    console.error("ERROR /api/store-reading:", err);
    return res
      .status(500)
      .json({ error: "Server error", details: err.message });
  }
});

// ---- Simple health check route ----
app.get("/", (req, res) => {
  res.send("AgriVision IoT API is running ✅");
});

// ---- Start server after Mongo connects ----
async function start() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB:", DATABASE_NAME);
    app.listen(PORT, () => {
      console.log(`🚀 Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to connect to MongoDB:", err);
    process.exit(1);
  }
}

start();
