export function SignInRequired() {
  return (
    <>
      <h1>Sign-in required</h1>
      <p className="notice">This staging app uses an internal test session. No valid session cookie was found.</p>
    </>
  );
}
