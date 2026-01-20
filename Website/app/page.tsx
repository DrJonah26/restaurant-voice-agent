import { Navbar } from "@/components/navbar"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import Link from "next/link"
import { Check, Phone, Clock, Globe, Users, Shield } from "lucide-react"

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      
      {/* Hero Section */}
      <section className="container py-20 md:py-32">
        <div className="flex flex-col items-center text-center space-y-8">
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight">
            KI-Telefonassistent für Restaurants
          </h1>
          <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl">
            Automatische Reservierungen, 24/7 erreichbar. Kein verpasster Anruf mehr.
          </p>
          <div className="flex flex-col sm:flex-row gap-4">
            <Link href="#demo">
              <Button size="lg" className="w-full sm:w-auto">
                Demo anhören
              </Button>
            </Link>
            <Link href="/register">
              <Button size="lg" variant="outline" className="w-full sm:w-auto">
                Kostenlos starten
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="container py-20 bg-muted/50">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Alles was Sie brauchen
          </h2>
          <p className="text-lg text-muted-foreground">
            Ihr KI-Assistent übernimmt die Reservierungen für Sie
          </p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Card>
            <CardHeader>
              <Phone className="h-10 w-10 text-primary mb-4" />
              <CardTitle>Automatische Telefonannahme</CardTitle>
              <CardDescription>
                Ihr Assistent nimmt jeden Anruf entgegen, auch außerhalb der Öffnungszeiten
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <Users className="h-10 w-10 text-primary mb-4" />
              <CardTitle>Intelligente Reservierungslogik</CardTitle>
              <CardDescription>
                Berücksichtigt automatisch Verfügbarkeit, Tischgröße und Öffnungszeiten
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <Clock className="h-10 w-10 text-primary mb-4" />
              <CardTitle>Öffnungszeiten & Sitzplätze</CardTitle>
              <CardDescription>
                Respektiert Ihre Öffnungszeiten und prüft die Verfügbarkeit in Echtzeit
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <Globe className="h-10 w-10 text-primary mb-4" />
              <CardTitle>Mehrsprachigkeit</CardTitle>
              <CardDescription>
                Unterstützt mehrere Sprachen für internationale Gäste
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <Shield className="h-10 w-10 text-primary mb-4" />
              <CardTitle>Kein verpasster Anruf mehr</CardTitle>
              <CardDescription>
                Jeder Anruf wird professionell entgegengenommen und dokumentiert
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <Check className="h-10 w-10 text-primary mb-4" />
              <CardTitle>Einfache Integration</CardTitle>
              <CardDescription>
                In wenigen Minuten eingerichtet, keine technischen Kenntnisse erforderlich
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </section>

      {/* Demo Section */}
      <section id="demo" className="container py-20">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Hören Sie selbst
            </h2>
            <p className="text-lg text-muted-foreground">
              Beispiel-Telefonat mit unserem KI-Assistenten
            </p>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Demo-Anruf</CardTitle>
              <CardDescription>
                Ein Beispiel-Gespräch zwischen einem Gast und unserem KI-Assistenten
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-muted rounded-lg p-4">
                <audio controls className="w-full">
                  <source src="/demo-call.mp3" type="audio/mpeg" />
                  Ihr Browser unterstützt das Audio-Element nicht.
                </audio>
              </div>
              <div className="space-y-2 text-sm">
                <p className="font-semibold">Gesprächsverlauf:</p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>KI-Assistent begrüßt den Anrufer freundlich</li>
                  <li>Erfragt gewünschtes Datum und Uhrzeit</li>
                  <li>Prüft Verfügbarkeit basierend auf Öffnungszeiten</li>
                  <li>Fragt nach Anzahl der Personen</li>
                  <li>Bestätigt die Reservierung mit allen Details</li>
                  <li>Verabschiedet sich höflich</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Social Proof */}
      <section className="container py-20 bg-muted/50">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Vertrauen Sie auf uns
          </h2>
        </div>
        <div className="grid md:grid-cols-3 gap-8 max-w-4xl mx-auto">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Restaurant Bella Vista</CardTitle>
              <CardDescription>
                "Seit wir den KI-Assistenten nutzen, haben wir keine Reservierung mehr verpasst. Die Gäste sind begeistert von der professionellen Ansprache."
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-semibold">— Maria Schmidt, Inhaberin</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Café am Markt</CardTitle>
              <CardDescription>
                "Die Einrichtung war super einfach. Innerhalb von 10 Minuten war alles konfiguriert. Jetzt haben wir mehr Zeit für unsere Gäste."
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-semibold">— Thomas Weber, Geschäftsführer</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Steakhouse Premium</CardTitle>
              <CardDescription>
                "Besonders am Wochenende ist der Assistent ein Lebensretter. Wir können uns auf die Küche konzentrieren, während er die Reservierungen übernimmt."
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-semibold">— Julia Müller, Managerin</p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Final CTA */}
      <section className="container py-20">
        <div className="max-w-2xl mx-auto text-center space-y-8">
          <h2 className="text-3xl md:text-4xl font-bold">
            Bereit loszulegen?
          </h2>
          <p className="text-xl text-muted-foreground">
            Starten Sie noch heute und lassen Sie unseren KI-Assistenten für Sie arbeiten
          </p>
          <Link href="/register">
            <Button size="lg" className="text-lg px-8">
              Jetzt KI-Assistent aktivieren
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t mt-auto py-8">
        <div className="container text-center text-sm text-muted-foreground">
          <p>© 2024 RestaurantVoice. Alle Rechte vorbehalten.</p>
        </div>
      </footer>
    </div>
  )
}
