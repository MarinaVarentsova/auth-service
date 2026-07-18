export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center space-y-4 p-8">
        <h1 className="text-4xl font-bold text-gray-900">Auth Service</h1>
        <p className="text-lg text-gray-600">Служба авторизации запущена.</p>
        <div className="mt-6 inline-block px-4 py-2 bg-green-100 text-green-800 rounded-full text-sm font-medium">
          ✓ Running
        </div>
      </div>
    </main>
  );
}
