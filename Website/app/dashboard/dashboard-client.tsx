"use client"

import { useState } from "react"
import { Navbar } from "@/components/navbar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Phone, CheckCircle, XCircle, Clock, Calendar } from "lucide-react"
import { SettingsTab } from "./settings-tab"

interface DashboardClientProps {
  initialData: {
    restaurant: any
    stats: {
      totalCalls: number
      successfulReservations: number
      missedCalls: number
      rejectedCalls: number
      upcomingReservations: number
    }
  }
}

export function DashboardClient({ initialData }: DashboardClientProps) {
  const [activeTab, setActiveTab] = useState("overview")

  const formatDate = (date: Date | string) => {
    return new Date(date).toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    })
  }

  const formatTime = (time: string) => {
    return time
  }

  const formatDateTime = (date: Date | string) => {
    return new Date(date).toLocaleString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  const getResultBadge = (result: string) => {
    const styles = {
      reserved: "bg-green-100 text-green-800",
      rejected: "bg-red-100 text-red-800",
      no_space: "bg-yellow-100 text-yellow-800",
      missed: "bg-gray-100 text-gray-800",
    }
    const labels = {
      reserved: "Reserviert",
      rejected: "Abgelehnt",
      no_space: "Kein Platz",
      missed: "Verpasst",
    }
    return (
      <span className={`px-2 py-1 rounded-full text-xs font-semibold ${styles[result as keyof typeof styles] || ""}`}>
        {labels[result as keyof typeof labels] || result}
      </span>
    )
  }

  const getStatusBadge = (status: string) => {
    const styles = {
      confirmed: "bg-green-100 text-green-800",
      canceled: "bg-red-100 text-red-800",
      completed: "bg-gray-100 text-gray-800",
    }
    const labels = {
      confirmed: "Bestätigt",
      canceled: "Storniert",
      completed: "Abgeschlossen",
    }
    return (
      <span className={`px-2 py-1 rounded-full text-xs font-semibold ${styles[status as keyof typeof styles] || ""}`}>
        {labels[status as keyof typeof labels] || status}
      </span>
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <div className="container py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground">
            Willkommen zurück, {initialData.restaurant.name}
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="overview">Übersicht</TabsTrigger>
            <TabsTrigger value="calls">Anrufe</TabsTrigger>
            <TabsTrigger value="reservations">Reservierungen</TabsTrigger>
            <TabsTrigger value="settings">Einstellungen</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    Eingegangene Anrufe
                  </CardTitle>
                  <Phone className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {initialData.stats.totalCalls}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Gesamt
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    Erfolgreiche Reservierungen
                  </CardTitle>
                  <CheckCircle className="h-4 w-4 text-green-600" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-600">
                    {initialData.stats.successfulReservations}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Erfolgreich
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    Verpasste Anrufe
                  </CardTitle>
                  <XCircle className="h-4 w-4 text-red-600" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-red-600">
                    {initialData.stats.missedCalls}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Verpasst
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    Abgelehnte Anrufe
                  </CardTitle>
                  <XCircle className="h-4 w-4 text-yellow-600" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-yellow-600">
                    {initialData.stats.rejectedCalls}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Abgelehnt
                  </p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Bevorstehende Reservierungen</CardTitle>
                <CardDescription>
                  {initialData.stats.upcomingReservations} bestätigte Reservierungen
                </CardDescription>
              </CardHeader>
              <CardContent>
                {initialData.restaurant.reservations.filter(
                  (r: any) => r.status === "confirmed" && new Date(r.reservationDate) >= new Date()
                ).length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">
                    Keine bevorstehenden Reservierungen
                  </p>
                ) : (
                  <div className="space-y-4">
                    {initialData.restaurant.reservations
                      .filter((r: any) => r.status === "confirmed" && new Date(r.reservationDate) >= new Date())
                      .slice(0, 5)
                      .map((reservation: any) => (
                        <div
                          key={reservation.id}
                          className="flex items-center justify-between p-4 border rounded-lg"
                        >
                          <div>
                            <p className="font-semibold">
                              {formatDate(reservation.reservationDate)} um {formatTime(reservation.reservationTime)}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {reservation.personCount} Personen
                            </p>
                          </div>
                          {getStatusBadge(reservation.status)}
                        </div>
                      ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="calls" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Anrufprotokoll</CardTitle>
                <CardDescription>
                  Alle eingehenden Anrufe und deren Ergebnisse
                </CardDescription>
              </CardHeader>
              <CardContent>
                {initialData.restaurant.callLogs.length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">
                    Noch keine Anrufe registriert
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left p-2">Datum & Uhrzeit</th>
                          <th className="text-left p-2">Dauer</th>
                          <th className="text-left p-2">Ergebnis</th>
                          <th className="text-left p-2">Personen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {initialData.restaurant.callLogs.map((call: any) => (
                          <tr key={call.id} className="border-b">
                            <td className="p-2">{formatDateTime(call.createdAt)}</td>
                            <td className="p-2">{call.duration}s</td>
                            <td className="p-2">{getResultBadge(call.result)}</td>
                            <td className="p-2">{call.personCount || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="reservations" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Reservierungen</CardTitle>
                <CardDescription>
                  Alle Reservierungen Ihres Restaurants
                </CardDescription>
              </CardHeader>
              <CardContent>
                {initialData.restaurant.reservations.length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">
                    Noch keine Reservierungen
                  </p>
                ) : (
                  <div className="space-y-4">
                    {initialData.restaurant.reservations.map((reservation: any) => (
                      <div
                        key={reservation.id}
                        className="flex items-center justify-between p-4 border rounded-lg"
                      >
                        <div>
                          <p className="font-semibold">
                            {formatDate(reservation.reservationDate)} um {formatTime(reservation.reservationTime)}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {reservation.personCount} Personen • {reservation.phoneNumber}
                          </p>
                          {reservation.notes && (
                            <p className="text-sm text-muted-foreground mt-1">
                              {reservation.notes}
                            </p>
                          )}
                        </div>
                        {getStatusBadge(reservation.status)}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings">
            <SettingsTab restaurant={initialData.restaurant} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
