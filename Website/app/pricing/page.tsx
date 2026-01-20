import { Navbar } from "@/components/navbar"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import Link from "next/link"
import { Check } from "lucide-react"

const plans = [
  {
    name: "Starter",
    price: "49",
    description: "Perfekt für kleine Restaurants",
    features: [
      "Bis zu 100 Anrufe/Monat",
      "Automatische Reservierungen",
      "Öffnungszeiten-Verwaltung",
      "E-Mail Support",
      "Basis-Analytics",
    ],
    popular: false,
  },
  {
    name: "Pro",
    price: "99",
    description: "Für wachsende Restaurants",
    features: [
      "Bis zu 500 Anrufe/Monat",
      "Alle Starter Features",
      "Mehrsprachigkeit",
      "Prioritäts-Support",
      "Erweiterte Analytics",
      "API-Zugang",
    ],
    popular: true,
  },
  {
    name: "Enterprise",
    price: "199",
    description: "Für große Restaurants & Ketten",
    features: [
      "Unbegrenzte Anrufe",
      "Alle Pro Features",
      "White-Label Option",
      "Dedicated Account Manager",
      "Custom Integration",
      "SLA-Garantie",
    ],
    popular: false,
  },
]

export default function PricingPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      
      <section className="container py-20">
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            Einfache, transparente Preise
          </h1>
          <p className="text-xl text-muted-foreground">
            Wählen Sie den Plan, der zu Ihrem Restaurant passt
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {plans.map((plan) => (
            <Card
              key={plan.name}
              className={plan.popular ? "border-primary border-2 relative" : ""}
            >
              {plan.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                  <span className="bg-primary text-primary-foreground px-4 py-1 rounded-full text-sm font-semibold">
                    Beliebt
                  </span>
                </div>
              )}
              <CardHeader>
                <CardTitle className="text-2xl">{plan.name}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
                <div className="mt-4">
                  <span className="text-4xl font-bold">{plan.price}€</span>
                  <span className="text-muted-foreground">/Monat</span>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <ul className="space-y-3">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <Check className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                      <span className="text-sm">{feature}</span>
                    </li>
                  ))}
                </ul>
                <Link href="/register" className="block">
                  <Button
                    className="w-full"
                    variant={plan.popular ? "default" : "outline"}
                  >
                    Jetzt starten
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="mt-12 text-center">
          <p className="text-muted-foreground mb-4">
            Alle Pläne können jederzeit gekündigt werden. Keine versteckten Kosten.
          </p>
          <p className="text-sm text-muted-foreground">
            Stripe Checkout Integration wird nach Registrierung aktiviert
          </p>
        </div>
      </section>
    </div>
  )
}
