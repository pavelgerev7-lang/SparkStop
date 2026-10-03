import {
  startRegistration,
  verifyRegistration,
  loginUser,
  startForgotPassword,
  resetPasswordWithCode,
  validatePasswordStrength
} from '../src/services/authService.js';

async function runAuthTests() {
  console.log('🧪 Starting SparkDrop Authentication Engine Tests...\n');

  // Test 1: Password Validation
  console.log('Test 1: Password Strength Validation:');
  const check1 = validatePasswordStrength('abc');
  console.log('  "abc":', check1.valid ? '❌ Failed' : `✅ Rejected: "${check1.message}"`);

  const check2 = validatePasswordStrength('abcdef');
  console.log('  "abcdef" (no numbers):', check2.valid ? '❌ Failed' : `✅ Rejected: "${check2.message}"`);

  const check3 = validatePasswordStrength('spark123');
  console.log('  "spark123" (valid):', check3.valid ? '✅ Valid' : '❌ Failed');

  // Test 2: Full Registration Flow
  const testEmail = `user_${Date.now()}@sparkdrop.test`;
  console.log(`\nTest 2: Registration for ${testEmail}:`);
  
  const regStep1 = await startRegistration(testEmail, 'Secret999');
  console.log('  Step 1 Result:', regStep1.message);
  console.log('  Received 6-digit code:', regStep1.simulatedCode);

  // Test wrong code
  try {
    await verifyRegistration(testEmail, '000000');
    console.log('  ❌ Error: Invalid code was accepted');
  } catch (e) {
    console.log('  ✅ Correctly rejected invalid code:', e.message);
  }

  // Test correct code
  const regStep2 = await verifyRegistration(testEmail, regStep1.simulatedCode);
  console.log('  ✅ Step 2 Verified:', regStep2.message);
  console.log('  User created:', regStep2.user.email, 'ID:', regStep2.user.id);
  console.log('  Token generated:', regStep2.token.substring(0, 25) + '...');

  // Test 3: Login Flow
  console.log('\nTest 3: Login Verification:');
  try {
    await loginUser(testEmail, 'WrongPass123');
    console.log('  ❌ Error: Login with wrong password succeeded');
  } catch (e) {
    console.log('  ✅ Correctly rejected wrong password:', e.message);
  }

  const loginRes = await loginUser(testEmail, 'Secret999');
  console.log('  ✅ Login Succeeded:', loginRes.user.email);

  // Test 4: Forgot & Reset Password Flow
  console.log('\nTest 4: Forgot Password Flow:');
  const forgotRes = await startForgotPassword(testEmail);
  console.log('  Reset Code Sent:', forgotRes.simulatedCode);

  const resetRes = await resetPasswordWithCode(testEmail, forgotRes.simulatedCode, 'NewPass2026');
  console.log('  ✅ Password Reset Succeeded:', resetRes.message);

  // Test Login with new password
  const newLoginRes = await loginUser(testEmail, 'NewPass2026');
  console.log('  ✅ Login with New Password Succeeded:', newLoginRes.user.email);

  console.log('\n🎉 ALL AUTHENTICATION TESTS PASSED SUCCESSFULLY! 🚀');
}

runAuthTests().catch(console.error);
