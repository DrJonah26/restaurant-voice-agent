# RestaurantVoice - KI-Telefonassistent für Restaurants

Eine vollständige SaaS-Webanwendung für ein KI-Telefonassistent-Produkt, das automatisch Telefonanrufe entgegennimmt und Reservierungen für Restaurants verwaltet.

## 🚀 Features

- **Conversion-starke Landing Page** mit Hero-Section, Features, Demo und Social Proof
- **Pricing Page** mit 3 verschiedenen Plänen (Starter, Pro, Enterprise)
- **Authentifizierung** mit NextAuth (Credentials Provider)
- **Onboarding-Flow** zur Konfiguration des Restaurants
- **Dashboard** mit Übersicht, Anrufprotokoll, Reservierungen und Einstellungen
- **Moderne UI** mit Tailwind CSS und shadcn/ui Komponenten
- **Datenbank** mit Prisma und SQLite (PostgreSQL-ready)

## 🛠 Tech-Stack

- **Frontend:** Next.js 14 (App Router), React, TypeScript
- **Styling:** Tailwind CSS
- **Backend:** Next.js API Routes
- **Auth:** NextAuth.js
- **DB:** Prisma + SQLite (lokal, PostgreSQL-ready)
- **Payments:** Stripe (vorbereitet, noch nicht integriert)

## 📋 Voraussetzungen

- Node.js 18+ 
- npm oder yarn

## 🏃 Setup & Installation

1. **Repository klonen und Abhängigkeiten installieren:**

```bash
npm install
```

2. **Umgebungsvariablen einrichten:**

Erstellen Sie eine `.env` Datei im Root-Verzeichnis:

```env
DATABASE_URL="file:./dev.db"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="your-secret-key-here-change-in-production"
```

3. **Datenbank initialisieren:**

```bash
npx prisma generate
npx prisma db push
```

4. **Mock-Daten einfügen (optional):**

```bash
npm run db:seed
```

Dies erstellt einen Test-Benutzer:
- Email: `test@example.com`
- Passwort: `password123`

5. **Entwicklungsserver starten:**

```bash
npm run dev
```

Die Anwendung läuft nun auf [http://localhost:3000](http://localhost:3000)

## 📁 Projektstruktur

```
├── app/                    # Next.js App Router Seiten
│   ├── api/               # API Routes
│   ├── dashboard/         # Dashboard-Seiten
│   ├── login/             # Login-Seite
│   ├── register/          # Registrierungs-Seite
│   ├── onboarding/        # Onboarding-Flow
│   ├── pricing/           # Pricing-Seite
│   └── page.tsx           # Landing Page
├── components/            # React Komponenten
│   ├── ui/               # UI-Komponenten (shadcn/ui)
│   └── navbar.tsx        # Navigation
├── lib/                   # Utility-Funktionen
│   ├── auth.ts           # NextAuth Konfiguration
│   ├── prisma.ts         # Prisma Client
│   └── utils.ts          # Helper-Funktionen
├── prisma/               # Prisma Schema & Seeds
│   ├── schema.prisma     # Datenbank-Schema
│   └── seed.ts           # Seed-Script
└── types/                # TypeScript Typen
```

## 🗄 Datenbank-Modelle

- **User:** Benutzer-Accounts
- **Restaurant:** Restaurant-Konfiguration
- **Subscription:** Abo-Informationen
- **OpeningHours:** Öffnungszeiten pro Wochentag
- **CallLog:** Anrufprotokoll
- **Reservation:** Reservierungen

## 🔐 Authentifizierung

Die Anwendung verwendet NextAuth.js mit Credentials Provider. OAuth-Provider (z.B. Google) können einfach hinzugefügt werden.

## 💳 Stripe Integration

Die Stripe-Integration ist vorbereitet, aber noch nicht vollständig implementiert. Die Pricing-Seite zeigt die Pläne an, aber der Checkout-Flow muss noch implementiert werden.

## 🎨 UI-Komponenten

Die Anwendung verwendet shadcn/ui Komponenten, die auf Radix UI und Tailwind CSS basieren.

## 📝 Nächste Schritte

- [ ] Stripe Checkout Integration vollständig implementieren
- [ ] OAuth-Provider (Google) hinzufügen
- [ ] E-Mail-Verifizierung implementieren
- [ ] Echte Telefon-Integration (Twilio o.ä.)
- [ ] Erweiterte Analytics im Dashboard
- [ ] Export-Funktionen für Reservierungen
- [ ] Multi-Tenant Support für Restaurant-Ketten

## 📄 Lizenz

MIT

## 🤝 Beitragen

Beiträge sind willkommen! Bitte erstellen Sie einen Pull Request oder öffnen Sie ein Issue.
