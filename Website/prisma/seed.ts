import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

const prisma = new PrismaClient()

async function main() {
  console.log("Seeding database...")

  // Create test user
  const hashedPassword = await bcrypt.hash("password123", 10)
  
  const user = await prisma.user.upsert({
    where: { email: "test@example.com" },
    update: {},
    create: {
      email: "test@example.com",
      password: hashedPassword,
      name: "Test User",
      subscription: {
        create: {
          plan: "pro",
          status: "active",
        },
      },
    },
  })

  console.log("Created user:", user.email)

  // Create restaurant
  const restaurant = await prisma.restaurant.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      name: "Restaurant Bella Vista",
      size: "medium",
      tableCount: 15,
      seatCount: 45,
      phoneNumber: "+49 123 456789",
      language: "de",
      openingHours: {
        create: [
          { dayOfWeek: 1, openTime: "11:00", closeTime: "22:00", isClosed: false },
          { dayOfWeek: 2, openTime: "11:00", closeTime: "22:00", isClosed: false },
          { dayOfWeek: 3, openTime: "11:00", closeTime: "22:00", isClosed: false },
          { dayOfWeek: 4, openTime: "11:00", closeTime: "22:00", isClosed: false },
          { dayOfWeek: 5, openTime: "11:00", closeTime: "23:00", isClosed: false },
          { dayOfWeek: 6, openTime: "11:00", closeTime: "23:00", isClosed: false },
          { dayOfWeek: 0, openTime: "12:00", closeTime: "21:00", isClosed: false },
        ],
      },
    },
  })

  console.log("Created restaurant:", restaurant.name)

  // Create sample call logs
  const callLogs = await Promise.all([
    prisma.callLog.create({
      data: {
        restaurantId: restaurant.id,
        phoneNumber: "+49 987 654321",
        duration: 120,
        result: "reserved",
        personCount: 4,
      },
    }),
    prisma.callLog.create({
      data: {
        restaurantId: restaurant.id,
        phoneNumber: "+49 987 654322",
        duration: 45,
        result: "reserved",
        personCount: 2,
      },
    }),
    prisma.callLog.create({
      data: {
        restaurantId: restaurant.id,
        phoneNumber: "+49 987 654323",
        duration: 30,
        result: "rejected",
        personCount: 8,
      },
    }),
    prisma.callLog.create({
      data: {
        restaurantId: restaurant.id,
        phoneNumber: "+49 987 654324",
        duration: 15,
        result: "missed",
      },
    }),
  ])

  console.log("Created call logs:", callLogs.length)

  // Create sample reservations
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  
  const reservations = await Promise.all([
    prisma.reservation.create({
      data: {
        restaurantId: restaurant.id,
        phoneNumber: "+49 987 654321",
        personCount: 4,
        reservationDate: tomorrow,
        reservationTime: "19:00",
        status: "confirmed",
      },
    }),
    prisma.reservation.create({
      data: {
        restaurantId: restaurant.id,
        phoneNumber: "+49 987 654322",
        personCount: 2,
        reservationDate: tomorrow,
        reservationTime: "20:00",
        status: "confirmed",
      },
    }),
  ])

  console.log("Created reservations:", reservations.length)
  console.log("Seeding completed!")
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
