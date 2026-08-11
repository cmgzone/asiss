import { chromium } from 'playwright';

async function testWeb() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Log console messages
  page.on('console', msg => {
    console.log(`[BROWSER CONSOLE] [${msg.type()}] ${msg.text()}`);
  });

  // Log page errors
  page.on('pageerror', err => {
    console.error(`[BROWSER ERROR] ${err.message}`);
  });

  try {
    console.log('Navigating to http://localhost:3000 ...');
    await page.goto('http://localhost:3000');

    console.log('Checking for login overlay...');
    const isLoginVisible = await page.isVisible('#login-overlay');
    console.log(`Login overlay visible: ${isLoginVisible}`);

    if (isLoginVisible) {
      console.log('Filling login credentials...');
      await page.fill('#login-username', 'admin');
      await page.fill('#login-password', 'admin');
      console.log('Clicking login button...');
      await page.click('#login-btn');
      
      // Wait for login overlay to hide
      await page.waitForSelector('#login-overlay', { state: 'hidden', timeout: 5000 });
      console.log('Login successful!');
    }

    // Wait a bit to capture any post-login console logs or socket connection logs
    await page.waitForTimeout(3000);
    
    // Check if the chat input is visible
    const isChatInputVisible = await page.isVisible('#chat-input');
    console.log(`Chat input visible: ${isChatInputVisible}`);

  } catch (error) {
    console.error('Test encountered an error:', error);
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
}

testWeb();
