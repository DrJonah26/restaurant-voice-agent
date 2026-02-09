"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { useSession } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Navbar } from "@/components/navbar"
import { Info } from "lucide-react"

const DAYS = [
  { value: 0, label: "Sonntag" },
  { value: 1, label: "Montag" },
  { value: 2, label: "Dienstag" },
  { value: 3, label: "Mittwoch" },
  { value: 4, label: "Donnerstag" },
  { value: 5, label: "Freitag" },
  { value: 6, label: "Samstag" },
]

export default function OnboardingPage() {
  const router = useRouter()
  const { data: session, status } = useSession()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  
  const [formData, setFormData] = useState({
    restaurantName: "",
    size: "medium",
    tableCount: "",
    seatCount: "",
    phoneNumber: "",
    handoffPhoneNumber: "",
    language: "de",
  })

  const [openingHours, setOpeningHours] = useState(
    DAYS.map((day) => ({
      dayOfWeek: day.value,
      openTime: "11:00",
      closeTime: "22:00",
      isClosed: false,
    }))
  )

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login")
    }
  }, [status, router])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setLoading(true)

    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          tableCount: parseInt(formData.tableCount),
          seatCount: parseInt(formData.seatCount),
          openingHours,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || "Fehler beim Speichern")
        return
      }

      router.push("/dashboard")
    } catch (err) {
      setError("Ein Fehler ist aufgetreten")
    } finally {
      setLoading(false)
    }
  }

  const updateOpeningHours = (dayOfWeek: number, field: string, value: string | boolean) => {
    setOpeningHours((prev) =>
      prev.map((oh) =>
        oh.dayOfWeek === dayOfWeek ? { ...oh, [field]: value } : oh
      )
    )
  }

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div>Wird geladen...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <div className="flex-1 container py-12 max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Restaurant konfigurieren</CardTitle>
            <CardDescription>
              Bitte geben Sie die Details Ihres Restaurants ein
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              {error && (
                <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
                  {error}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="restaurantName">Restaurantname *</Label>
                <Input
                  id="restaurantName"
                  value={formData.restaurantName}
                  onChange={(e) =>
                    setFormData({ ...formData, restaurantName: e.target.value })
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="size">Größe des Restaurants *</Label>
                <Select
                  value={formData.size}
                  onValueChange={(value) =>
                    setFormData({ ...formData, size: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="small">Klein (bis 20 Plätze)</SelectItem>
                    <SelectItem value="medium">Mittel (20-50 Plätze)</SelectItem>
                    <SelectItem value="large">Groß (50+ Plätze)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="tableCount">Anzahl der Tische *</Label>
                  <Input
                    id="tableCount"
                    type="number"
                    min="1"
                    value={formData.tableCount}
                    onChange={(e) =>
                      setFormData({ ...formData, tableCount: e.target.value })
                    }
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="seatCount">Anzahl der Sitzplätze *</Label>
                  <Input
                    id="seatCount"
                    type="number"
                    min="1"
                    value={formData.seatCount}
                    onChange={(e) =>
                      setFormData({ ...formData, seatCount: e.target.value })
                    }
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="phoneNumber">Geschäftsnummer</Label>
                <Input
                  id="phoneNumber"
                  type="tel"
                  placeholder="+49 123 456789"
                  value={formData.phoneNumber}
                  onChange={(e) =>
                    setFormData({ ...formData, phoneNumber: e.target.value })
                  }
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="handoffPhoneNumber">Weitere Telefonnummer *</Label>
                  <span className="group relative inline-flex">
                    <Info className="h-4 w-4 cursor-help text-muted-foreground" aria-hidden="true" />
                    <span className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 w-72 -translate-x-1/2 rounded-md bg-popover p-2 text-xs text-popover-foreground opacity-0 shadow-md ring-1 ring-border transition-opacity group-hover:opacity-100">
                      Damit wir Ihre Kunden bei Bedarf persönlich verbinden können, benötigen wir eine zweite Rufnummer für die KI-Weiterleitung.
                    </span>
                  </span>
                </div>
                <Input
                  id="handoffPhoneNumber"
                  type="tel"
                  placeholder="+49 123 456789"
                  value={formData.handoffPhoneNumber}
                  onChange={(e) =>
                    setFormData({ ...formData, handoffPhoneNumber: e.target.value })
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="language">Sprache des Telefonassistenten *</Label>
                <Select
                  value={formData.language}
                  onValueChange={(value) =>
                    setFormData({ ...formData, language: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="de">Deutsch</SelectItem>
                    <SelectItem value="en">Englisch</SelectItem>
                    <SelectItem value="fr">Französisch</SelectItem>
                    <SelectItem value="es">Spanisch</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-4">
                <Label>Öffnungszeiten *</Label>
                {DAYS.map((day) => {
                  const hours = openingHours.find(
                    (oh) => oh.dayOfWeek === day.value
                  )
                  return (
                    <div key={day.value} className="flex items-center gap-4">
                      <div className="w-24 text-sm">{day.label}</div>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={!hours?.isClosed}
                          onChange={(e) =>
                            updateOpeningHours(
                              day.value,
                              "isClosed",
                              !e.target.checked
                            )
                          }
                        />
                        <span className="text-sm">Geöffnet</span>
                      </label>
                      {hours && !hours.isClosed && (
                        <>
                          <Input
                            type="time"
                            value={hours.openTime}
                            onChange={(e) =>
                              updateOpeningHours(
                                day.value,
                                "openTime",
                                e.target.value
                              )
                            }
                            className="w-32"
                          />
                          <span className="text-sm">bis</span>
                          <Input
                            type="time"
                            value={hours.closeTime}
                            onChange={(e) =>
                              updateOpeningHours(
                                day.value,
                                "closeTime",
                                e.target.value
                              )
                            }
                            className="w-32"
                          />
                        </>
                      )}
                    </div>
                  )
                })}
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Wird gespeichert..." : "Speichern und fortfahren"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
