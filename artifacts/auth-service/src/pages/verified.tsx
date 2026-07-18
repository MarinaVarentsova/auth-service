import { Link } from "wouter";

export default function VerifiedPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center space-y-4 p-8 max-w-md">
        <div className="text-5xl mb-4">✅</div>
        <h1 className="text-3xl font-bold text-gray-900">Email подтвержден</h1>
        <p className="text-gray-600">Теперь можно войти в приложение.</p>
        <div className="mt-6">
          <Link href="/" className="text-blue-600 hover:underline text-sm">
            ← На главную
          </Link>
        </div>
      </div>
    </main>
  );
}
