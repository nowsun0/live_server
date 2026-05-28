require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Groq Server OK");
});

app.post("/chat", async (req, res) => {

  try {

    const message =
      req.body.message || "hello";

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization":
            `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [
            {
              role: "system",
              content:
                "당신은 라이브커머스 AI 채팅 도우미입니다."
            },
            {
              role: "user",
              content: message
            }
          ],
          temperature: 0.7
        })
      }
    );

    const data = await response.json();

    console.log(data);

    res.json(data);

  } catch (err) {

    console.log(err);

    res.status(500).json({
      error: err.message
    });

  }

});

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(
    `Server running on ${PORT}`
  );

});