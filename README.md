# DataFlow Session Monitor & Billing Proxy

An interactive Interledger-powered proxy server and dashboard designed to monitor network data usage and stream real-time payments based on user-allocated data budgets.

## Features
* **Real-Time Telemetry:** Monitors data consumption (in MB) and calculates costs instantly.
* **Dynamic Budget Enforcement:** Terminates data sessions automatically once user-allocated financial budgets are hit.
* **HTTPS Tunneling Support:** Seamlessly proxies standard HTTP requests and handles secure HTTPS traffic via `CONNECT` tunneling.
* **Clean Dashboard Interface:** A streamlined visual monitor with all core data usage metrics front and center.

---

## Architecture Overview

1. **Proxy Server (`proxy.js`):** Intercepts network requests, tracks bandwidth metrics (bytes sent/received), and coordinates with the billing mechanics.
2. **Backend Engine (`server.js`):** Manages an Express application, WebSockets for pushing live UI metrics, and interfaces with the `BillingEngine`.
3. **Frontend Dashboard (`dashboard.html`):** A clean client UI to initialize data budgets, manage transaction authentication redirects, and monitor session statuses.

---

## Getting Started

### 1. Prerequisites
Ensure you have [Node.js](https://nodejs.org/) (v16 or higher) installed on your system.

### 2. Installation
Clone or navigate to your project repository and install the required dependencies:
```bash
npm install
npm install dotenv
