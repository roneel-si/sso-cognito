const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "home.html"));
});

app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.post("/login/email-otp", (req, res) => {
  const { email, otp } = req.body;
  res.status(501).send(
    `Email+OTP submit received (not implemented). email=${email ?? ""}, otp=${otp ? "[redacted]" : ""}`
  );
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
